import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type Refund, type RefundStatus } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountsService, LedgerService } from "../wallet";
import { CouponsService } from "./coupons.service";
import { FinanceAlerts } from "./finance-alerts.service";
import { ORDER_LEDGER_REF, SALE_DESCRIPTION } from "./fulfilment.service";
import { HOLD_RELEASE_DESCRIPTION } from "./hold-release.processor";
import { toApi } from "./money";
import { RAZORPAY_CLIENT, RazorpayApiError, type RazorpayClient } from "./razorpay.client";
import { SellableRegistry, type PaidOrder } from "./sellable.registry";

export const REFUND_DESCRIPTION = "refund";
export const SYSTEM_ACTOR = "system";
/** Statuses in which a refund still counts against the order (mirrors the refunds_order_live_key partial unique index). */
export const LIVE_REFUND: RefundStatus[] = ["REQUESTED", "APPROVED", "PROCESSING", "PROCESSED"];
/** An APPROVED refund with no Razorpay id for this long was not started (outage, crash): the retry job picks it up. */
export const REFUND_RESUME_AFTER_MS = 2 * 60 * 1000;

/** What a refund.* webhook says about the refund. */
export interface RefundWebhookEntity {
  id: string;
  paymentId: string | null;
  /** notes.refundId: our refund id, put there when the refund was created. */
  refundIdNote: string | null;
}

export interface RefundView {
  id: string;
  orderId: string;
  status: RefundStatus;
  amountPaise: string;
  currency: "INR";
  reason: string;
  requestedBy: string;
  decidedBy: string | null;
  failureReason: string | null;
  createdAt: string;
}

export const toRefundView = (r: Refund): RefundView => ({
  id: r.id,
  orderId: r.orderId,
  status: r.status,
  amountPaise: toApi(r.amountPaise),
  currency: "INR",
  reason: r.reason,
  requestedBy: r.requestedBy,
  decidedBy: r.decidedBy,
  failureReason: r.failureReason,
  createdAt: r.createdAt.toISOString(),
});

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** The parts of a refund that work needs in both the API and the worker process: starting it at Razorpay and finishing it from the webhooks. */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAZORPAY_CLIENT) private readonly razorpay: RazorpayClient,
    private readonly registry: SellableRegistry,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
    private readonly coupons: CouponsService,
    private readonly alerts: FinanceAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * An order that was paid but could not be delivered is refunded without anyone asking: an APPROVED refund by the system actor
   * (a pending request by the buyer is approved instead), then started at Razorpay. Safe to repeat. A gateway outage throws, so
   * the outbox retries the event; the refund row survives and the retry job also finishes it.
   */
  async refundUndelivered(orderId: string): Promise<Refund | null> {
    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== "PAID") return null;
      const live = await tx.refund.findFirst({ where: { orderId, status: { in: LIVE_REFUND } } });
      if (live?.status === "REQUESTED") return tx.refund.update({ where: { id: live.id }, data: { status: "APPROVED", decidedBy: SYSTEM_ACTOR } });
      if (live) return live;
      try {
        return await tx.refund.create({
          data: { orderId, amountPaise: order.totalPaise, status: "APPROVED", reason: `Order could not be delivered: ${order.fulfilmentError ?? "unknown error"}`.slice(0, 1000), requestedBy: SYSTEM_ACTOR, decidedBy: SYSTEM_ACTOR },
        });
      } catch (err) {
        if (isUniqueViolation(err)) return tx.refund.findFirstOrThrow({ where: { orderId, status: { in: LIVE_REFUND } } });
        throw err;
      }
    });
    return refund ? this.start(refund.id) : null;
  }

  /**
   * Starts an APPROVED refund at Razorpay. The call is made outside any database transaction, with the refund id as the idempotency key,
   * and its result is stored afterwards (PROCESSING + razorpayRefundId); repeating it can never refund twice. A definitive refusal
   * (4xx) fails the refund; an outage (5xx, timeout) throws REFUND_GATEWAY_ERROR and leaves it APPROVED to be retried.
   */
  async start(refundId: string): Promise<Refund> {
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { order: { select: { razorpayPaymentId: true, id: true } } } });
    if (refund.status !== "APPROVED" || refund.razorpayRefundId) return refund;
    const paymentId = refund.order.razorpayPaymentId;
    if (!paymentId) throw new AppError("REFUND_NO_PAYMENT", 500, "The order has no payment to refund", { refundId });
    try {
      const made = await this.razorpay.createRefund(paymentId, { amountPaise: refund.amountPaise, notes: { refundId: refund.id, orderId: refund.orderId }, idempotencyKey: refund.id });
      await this.prisma.refund.updateMany({ where: { id: refund.id, status: "APPROVED", razorpayRefundId: null }, data: { status: "PROCESSING", razorpayRefundId: made.id } });
    } catch (err) {
      if (err instanceof RazorpayApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        // A 4xx can also mean "this refund already exists" (a retry after a crash, an idempotency key not honoured). Ask Razorpay what it
        // has for this payment before declaring failure; if even that lookup fails, treat it as an outage and retry later.
        let existing: Awaited<ReturnType<RazorpayClient["listRefunds"]>>[number] | undefined;
        try {
          existing = (await this.razorpay.listRefunds(paymentId)).find((r) => r.notes.refundId === refund.id);
        } catch (lookupErr) {
          this.logger.error(`refund ${refund.id}: Razorpay refused (${err.message}) and the refund lookup failed (${(lookupErr as Error).message}); it stays APPROVED`);
          throw new AppError("REFUND_GATEWAY_ERROR", 502, "The payment gateway is unavailable; the refund will be retried");
        }
        if (existing) {
          this.logger.warn(`refund ${refund.id}: adopting Razorpay refund ${existing.id} that already exists for it`);
          await this.prisma.refund.updateMany({ where: { id: refund.id, status: "APPROVED", razorpayRefundId: null }, data: { status: "PROCESSING", razorpayRefundId: existing.id } });
        } else {
          await this.failUnstarted(refund.id, err.message);
        }
      } else {
        this.logger.error(`refund ${refund.id}: Razorpay is unavailable (${(err as Error).message}); it stays APPROVED for a retry`);
        throw new AppError("REFUND_GATEWAY_ERROR", 502, "The payment gateway is unavailable; the refund will be retried");
      }
    }
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  }

  /** Retries refunds that were approved but never started. Returns how many were started. */
  async resumeStuck(limit = 50): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - REFUND_RESUME_AFTER_MS);
    const stuck = await this.prisma.refund.findMany({ where: { status: "APPROVED", razorpayRefundId: null, updatedAt: { lt: cutoff } }, orderBy: { id: "asc" }, take: limit });
    let started = 0;
    for (const r of stuck) {
      try {
        const after = await this.start(r.id);
        if (after.status === "PROCESSING") started += 1;
      } catch (err) {
        this.logger.warn(`refund ${r.id} could not be started yet: ${(err as Error).message}`);
      }
    }
    return started;
  }

  /**
   * The call path: Razorpay refused the refund for good. Only a refund that is still APPROVED and has no Razorpay id can fail here; a
   * refund that is already PROCESSING is in flight and only the refund.failed webhook may fail it.
   */
  private async failUnstarted(refundId: string, why: string): Promise<void> {
    const failed = await this.prisma.refund.updateMany({ where: { id: refundId, status: "APPROVED", razorpayRefundId: null }, data: { status: "FAILED", failureReason: why.slice(0, 500) } });
    if (failed.count > 0) await this.alertFailed(refundId, why);
  }

  /** The refund.failed webhook: Razorpay reports that a refund it accepted did not go through. */
  private async failFromWebhook(refundId: string, why: string): Promise<void> {
    const failed = await this.prisma.refund.updateMany({ where: { id: refundId, status: { in: ["APPROVED", "PROCESSING"] } }, data: { status: "FAILED", failureReason: why.slice(0, 500) } });
    if (failed.count > 0) await this.alertFailed(refundId, why);
  }

  private async alertFailed(refundId: string, why: string): Promise<void> {
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    await this.alerts.raise({
      kind: "REFUND_FAILED",
      orderId: refund.orderId,
      message: `The refund of order ${refund.orderId} (refund ${refund.id}) failed: ${why}`,
      dedupeKey: `refund-failed:${refund.id}`,
      data: { refundId: refund.id },
    });
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * refund.processed: the money went back to the buyer. One transaction, under the order row lock (the same lock the hold release takes),
   * posts the reversal, undoes the delivery, closes the coupon use and marks the order REFUNDED. Idempotent: a repeat finds PROCESSED.
   * An unknown Razorpay refund id throws, so the queue retries the event (the id may simply not be stored yet).
   */
  async onProcessed(entity: RefundWebhookEntity): Promise<void> {
    const known = await this.locate(entity);

    await this.prisma.$transaction(
      async (tx) => {
        // Order first, then the refund: the same order the hold release uses, so the two can never deadlock.
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${known.orderId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${known.id} FOR UPDATE`;
        const refund = await tx.refund.findUniqueOrThrow({ where: { id: known.id } });
        if (refund.status === "PROCESSED" || refund.status === "REJECTED") return;
        const order: PaidOrder = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, include: { items: true } });
        const item = order.items[0];
        if (!item) throw new AppError("ORDER_HAS_NO_ITEM", 500, "Order has no item", { orderId: order.id });

        if (order.status !== "PAID") {
          // Refunded through another path already: record the refund as done, post nothing twice.
          this.logger.warn(`refund ${refund.id} processed but order ${order.id} is ${order.status}; no reversal posted`);
          await tx.refund.update({ where: { id: refund.id }, data: { status: "PROCESSED" } });
          return;
        }

        await this.postReversal(tx, order);
        // A delivery that failed was rolled back at payment time: there is nothing to take away.
        if (!order.fulfilmentFailedAt) {
          const provider = this.registry.find(item.itemType);
          if (!provider) throw new AppError("SELLABLE_PROVIDER_MISSING", 500, `No provider is registered for ${item.itemType}`, { orderId: order.id });
          await provider.onRefunded(tx, order);
        }
        await tx.order.updateMany({ where: { id: order.id, status: "PAID" }, data: { status: "REFUNDED" } });
        await this.coupons.releaseRefunded(tx, order.id);
        await tx.refund.update({ where: { id: refund.id }, data: { status: "PROCESSED" } });
        await this.outbox.enqueue(tx, {
          type: "order.refunded",
          orderId: order.id,
          refundId: refund.id,
          buyerId: order.buyerId,
          sellerOwnerType: order.sellerOwnerType,
          sellerOwnerId: order.sellerOwnerId,
          itemType: item.itemType,
          itemId: item.itemId,
          itemTitle: item.title,
          amountPaise: toApi(refund.amountPaise),
        });
        this.logger.log(`order ${order.id} refunded (refund ${refund.id})`);
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  }

  /** refund.failed: the refund did not happen. Unknown ids are retried like refund.processed. */
  async onFailed(entity: RefundWebhookEntity): Promise<void> {
    const known = await this.locate(entity);
    await this.failFromWebhook(known.id, "Razorpay reported that the refund failed");
  }

  /**
   * Finds our refund for a webhook: by the Razorpay refund id, or - when the id was never stored (a crash between Razorpay accepting the
   * refund and us recording it) - by the refundId we put in the refund's notes, trusted only if the payment is the refund's order's and
   * the refund has no Razorpay id yet. A match adopts the id. Anything else is unknown and throws, so the queue retries.
   */
  private async locate(entity: RefundWebhookEntity): Promise<{ id: string; orderId: string }> {
    const byId = await this.prisma.refund.findUnique({ where: { razorpayRefundId: entity.id }, select: { id: true, orderId: true } });
    if (byId) return byId;
    if (entity.refundIdNote && entity.paymentId) {
      const candidate = await this.prisma.refund.findUnique({ where: { id: entity.refundIdNote }, include: { order: { select: { razorpayPaymentId: true } } } });
      if (candidate && !candidate.razorpayRefundId && ["APPROVED", "FAILED"].includes(candidate.status) && candidate.order.razorpayPaymentId === entity.paymentId) {
        const adopted = await this.prisma.refund.updateMany({ where: { id: candidate.id, razorpayRefundId: null }, data: { razorpayRefundId: entity.id } });
        if (adopted.count === 1) this.logger.warn(`refund ${candidate.id}: adopted Razorpay refund ${entity.id} from the webhook notes`);
        return { id: candidate.id, orderId: candidate.orderId };
      }
    }
    throw new Error(`unknown refund ${entity.id}: not stored yet, will retry`);
  }

  /**
   * The exact negation of the sale entry, line by line, so the reversal is zero-sum and restores every account the sale touched.
   * Before the hold was released the seller share comes back out of PENDING; after it, out of AVAILABLE (which may go negative:
   * the seller already withdrew, or is about to be blocked from withdrawing). "Released" is read under the order lock.
   */
  private async postReversal(tx: Prisma.TransactionClient, order: PaidOrder): Promise<void> {
    const sale = await tx.journalEntry.findUnique({
      where: { refType_refId_description: { refType: ORDER_LEDGER_REF, refId: order.id, description: SALE_DESCRIPTION } },
      include: { lines: { include: { account: { select: { kind: true, ownerType: true, ownerId: true } } } } },
    });
    if (!sale) throw new AppError("SALE_ENTRY_MISSING", 500, "The order has no sale entry to reverse", { orderId: order.id });
    const released = (await tx.journalEntry.count({ where: { refType: ORDER_LEDGER_REF, refId: order.id, description: HOLD_RELEASE_DESCRIPTION } })) > 0;
    const seller = await this.accounts.ensureSellerAccounts(tx, order.sellerOwnerType, order.sellerOwnerId);
    await this.ledger.post(tx, {
      refType: ORDER_LEDGER_REF,
      refId: order.id,
      description: REFUND_DESCRIPTION,
      lines: sale.lines.map((l) => {
        const sellerPending = l.account.kind === "PENDING" && l.account.ownerType === order.sellerOwnerType && l.account.ownerId === order.sellerOwnerId;
        return { accountId: released && sellerPending ? seller.AVAILABLE : l.accountId, amountPaise: -l.amountPaise };
      }),
    });
  }
}
