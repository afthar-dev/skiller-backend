import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type Order, type OrderStatus } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountsService, LedgerService } from "../wallet";
import { FinanceAlerts, type FinanceAlertKind } from "./finance-alerts.service";
import { toApi } from "./money";
import { RAZORPAY_CLIENT, RazorpayApiError, type RazorpayClient, type RazorpayPayment } from "./razorpay.client";
import { saleLines, splitSale } from "./sale-split";
import { SellableRegistry, type PaidOrder } from "./sellable.registry";

export const ORDER_LEDGER_REF = "ORDER";
export const SALE_DESCRIPTION = "sale";

/** States a successful, correctly-priced payment may still move to PAID: the money has arrived, so the buyer gets the product. */
const FULFILLABLE: OrderStatus[] = ["CREATED", "FAILED", "EXPIRED"];

export type FulfilOutcome = "FULFILLED" | "ALREADY_PAID" | "DUPLICATE_PAYMENT" | "PENDING_CAPTURE";

export interface FulfilResult {
  orderId: string;
  status: OrderStatus;
  outcome: FulfilOutcome;
}

interface Anomaly {
  kind: FinanceAlertKind;
  message: string;
  dedupeKey: string;
  data?: Record<string, unknown>;
}

type TxOutcome = { kind: "fulfilled"; anomalies: Anomaly[] } | { kind: "already" } | { kind: "duplicate" } | { kind: "ignored"; status: OrderStatus };

/**
 * Turns a captured Razorpay payment into a paid order. Called by the client verify route and by the payment.captured webhook,
 * in any order and any number of times: the order row is locked, the PAID transition is a conditional UPDATE, and the ledger
 * entry is keyed (ORDER, orderId, sale), so exactly one of the calls does the work and the rest are no-ops.
 */
@Injectable()
export class FulfilmentService {
  private readonly logger = new Logger(FulfilmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAZORPAY_CLIENT) private readonly razorpay: RazorpayClient,
    private readonly registry: SellableRegistry,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
    private readonly alerts: FinanceAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async fulfil(orderId: string, paymentId: string, source: "verify" | "webhook"): Promise<FulfilResult> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError("ORDER_NOT_FOUND", 404, "Order not found");
    if (order.status === "PAID" && order.razorpayPaymentId === paymentId) return { orderId, status: "PAID", outcome: "ALREADY_PAID" };

    const payment = await this.fetchPayment(paymentId);
    if (!order.razorpayOrderId || payment.orderId !== order.razorpayOrderId) {
      throw new AppError("PAYMENT_ORDER_MISMATCH", 422, "This payment does not belong to this order");
    }
    if (order.status === "PAID") {
      // Another payment on an already-paid order: only a captured one holds the buyer's money twice.
      return payment.status === "captured" && payment.captured ? this.recordDuplicate(order, payment) : { orderId, status: "PAID", outcome: "ALREADY_PAID" };
    }
    if (!FULFILLABLE.includes(order.status)) return { orderId, status: order.status, outcome: "ALREADY_PAID" };

    // authorized / created: the money is not ours yet. The caller waits (verify answers 202, the webhook retries).
    if (payment.status === "authorized" || payment.status === "created") return { orderId, status: order.status, outcome: "PENDING_CAPTURE" };
    if (payment.status !== "captured" || !payment.captured) throw new AppError("PAYMENT_NOT_CAPTURED", 422, `The payment is ${payment.status}`);
    if (payment.amountPaise !== order.totalPaise || payment.currency !== order.currency) return this.rejectMismatch(order, payment);

    const outcome = await this.prisma.$transaction((tx) => this.fulfilInTx(tx, orderId, paymentId, source));
    switch (outcome.kind) {
      case "fulfilled":
        for (const a of outcome.anomalies) await this.alerts.raise({ ...a, orderId });
        return { orderId, status: "PAID", outcome: "FULFILLED" };
      case "already":
        return { orderId, status: "PAID", outcome: "ALREADY_PAID" };
      case "duplicate":
        return this.recordDuplicate(await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } }), payment);
      case "ignored":
        return { orderId, status: outcome.status, outcome: "ALREADY_PAID" };
    }
  }

  private async fulfilInTx(tx: Prisma.TransactionClient, orderId: string, paymentId: string, source: string): Promise<TxOutcome> {
    // Serialises every fulfilment of this order (verify, webhook, retries); the conditional UPDATE below is the state machine itself.
    await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: { in: FULFILLABLE } },
      data: { status: "PAID", razorpayPaymentId: paymentId, paidAt: this.clock.now() },
    });
    if (claimed.count === 0) {
      const current = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (current.status === "PAID") return current.razorpayPaymentId === paymentId ? { kind: "already" } : { kind: "duplicate" };
      return { kind: "ignored", status: current.status };
    }

    const order: PaidOrder = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    const item = order.items[0];
    if (!item) throw new AppError("ORDER_HAS_NO_ITEM", 500, "Order has no item", { orderId });
    const provider = this.registry.find(item.itemType);
    if (!provider) throw new AppError("SELLABLE_PROVIDER_MISSING", 500, `No provider is registered for ${item.itemType}`, { orderId });

    const anomalies = await this.redeemCoupon(tx, order);
    await this.postSale(tx, order);
    await provider.onPaid(tx, order);
    await this.outbox.enqueue(tx, {
      type: "order.paid",
      orderId: order.id,
      buyerId: order.buyerId,
      sellerOwnerType: order.sellerOwnerType,
      sellerOwnerId: order.sellerOwnerId,
      itemType: item.itemType,
      itemId: item.itemId,
      itemTitle: item.title,
      totalPaise: toApi(order.totalPaise),
      currency: order.currency,
      paidAt: (order.paidAt ?? this.clock.now()).toISOString(),
    });
    this.logger.log(`order ${orderId} paid by ${paymentId} (${source})`);
    return { kind: "fulfilled", anomalies };
  }

  /**
   * Counts the redemption now, under a lock on the coupon so concurrent payments cannot both take the last use. A paid order is
   * never refused: when the coupon is over its limit (or this user already redeemed it on a concurrent order) the buyer keeps
   * the discount they already paid for and finance is told.
   */
  private async redeemCoupon(tx: Prisma.TransactionClient, order: Order): Promise<Anomaly[]> {
    if (!order.couponId) return [];
    await tx.$queryRaw`SELECT "id" FROM "coupons" WHERE "id" = ${order.couponId} FOR UPDATE`;
    const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: order.couponId } });
    const used = await tx.couponRedemption.count({ where: { couponId: coupon.id } });
    const inserted = await tx.couponRedemption.createMany({ data: [{ couponId: coupon.id, userId: order.buyerId, orderId: order.id }], skipDuplicates: true });
    const anomalies: Anomaly[] = [];
    if (coupon.maxUses !== null && used >= coupon.maxUses) {
      anomalies.push({
        kind: "COUPON_OVER_LIMIT",
        message: `Coupon ${coupon.code} was redeemed beyond its limit of ${coupon.maxUses} (order ${order.id}); the buyer had already paid, so the order was fulfilled.`,
        dedupeKey: `coupon-over-limit:${order.id}`,
        data: { couponCode: coupon.code, maxUses: coupon.maxUses },
      });
    }
    if (inserted.count === 0) {
      anomalies.push({
        kind: "COUPON_REDEMPTION_CONFLICT",
        message: `Coupon ${coupon.code} was already redeemed by this buyer on another order (order ${order.id}).`,
        dedupeKey: `coupon-conflict:${order.id}`,
        data: { couponCode: coupon.code },
      });
    }
    for (const a of anomalies) this.logger.warn(a.message);
    return anomalies;
  }

  private async postSale(tx: Prisma.TransactionClient, order: Order): Promise<void> {
    const split = splitSale({ listPaise: order.listPricePaise, discountPaise: order.discountPaise, fundedBy: order.couponFundedBy, commissionBps: order.commissionBps, gstBps: order.gstBps });
    if (split.totalPaise !== order.totalPaise) throw new AppError("ORDER_TOTAL_INCONSISTENT", 500, "Order amounts do not add up", { orderId: order.id });
    const seller = await this.accounts.ensureSellerAccounts(tx, order.sellerOwnerType, order.sellerOwnerId);
    const account = {
      clearing: await this.accounts.platformAccount("GATEWAY_CLEARING", tx),
      seller: seller.PENDING,
      revenue: await this.accounts.platformAccount("PLATFORM_REVENUE", tx),
      tax: await this.accounts.platformAccount("TAX_PAYABLE", tx),
    };
    await this.ledger.post(tx, {
      refType: ORDER_LEDGER_REF,
      refId: order.id,
      description: SALE_DESCRIPTION,
      lines: saleLines(split).map((l) => ({ accountId: account[l.kind], amountPaise: l.amountPaise })),
    });
  }

  /** The buyer paid the wrong amount (tampering, or a gateway-side fault): the order fails, nothing is posted, finance is alerted. */
  private async rejectMismatch(order: Order, payment: RazorpayPayment): Promise<never> {
    await this.prisma.order.updateMany({ where: { id: order.id, status: "CREATED" }, data: { status: "FAILED" } });
    await this.alerts.raise({
      kind: "PAYMENT_AMOUNT_MISMATCH",
      orderId: order.id,
      message: `Payment ${payment.id} was ${toApi(payment.amountPaise)} ${payment.currency} but order ${order.id} expects ${toApi(order.totalPaise)} ${order.currency}. Nothing was credited.`,
      dedupeKey: `amount-mismatch:${order.id}:${payment.id}`,
      data: { paymentId: payment.id, paidPaise: toApi(payment.amountPaise), expectedPaise: toApi(order.totalPaise) },
    });
    throw new AppError("PAYMENT_AMOUNT_MISMATCH", 422, "The amount paid does not match the order");
  }

  /** A second payment captured against an order that is already PAID: keep it for a manual refund, never post it. */
  private async recordDuplicate(order: Order, payment: RazorpayPayment): Promise<FulfilResult> {
    const created = await this.prisma.duplicatePayment.createMany({ data: [{ orderId: order.id, razorpayPaymentId: payment.id, amountPaise: payment.amountPaise }], skipDuplicates: true });
    if (created.count === 1) {
      await this.alerts.raise({
        kind: "DUPLICATE_PAYMENT",
        orderId: order.id,
        message: `Order ${order.id} is already paid by ${order.razorpayPaymentId}, but payment ${payment.id} (${toApi(payment.amountPaise)} ${payment.currency}) was also captured. Refund it manually.`,
        dedupeKey: `duplicate-payment:${payment.id}`,
        data: { paymentId: payment.id, amountPaise: toApi(payment.amountPaise), paidWith: order.razorpayPaymentId },
      });
    }
    return { orderId: order.id, status: "PAID", outcome: "DUPLICATE_PAYMENT" };
  }

  private async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    try {
      return await this.razorpay.fetchPayment(paymentId);
    } catch (err) {
      if (err instanceof RazorpayApiError) {
        if (err.status === 400 || err.status === 404) throw new AppError("PAYMENT_NOT_FOUND", 422, "The payment could not be found at the gateway");
        throw new AppError("PAYMENT_GATEWAY_ERROR", 502, "The payment gateway is unavailable; try again");
      }
      throw err;
    }
  }
}
