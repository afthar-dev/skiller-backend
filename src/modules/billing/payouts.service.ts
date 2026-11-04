import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type Payout, type PayoutAccount, type PayoutMode, type PayoutStatus } from "@prisma/client";
import type { Queue } from "bullmq";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { QueueNames } from "../../common/queue/queue.constants";
import { SettingsService } from "../admin";
import { AuditService } from "../audit";
import type { MutationMeta } from "../rbac";
import { AccountsService, LedgerService } from "../wallet";
import type { Owner } from "./entitlements.service";
import { FinanceAlerts } from "./finance-alerts.service";
import { toApi } from "./money";
import { PayoutAccountsService } from "./payout-accounts.service";
import { RazorpayApiError } from "./razorpay.client";
import { RAZORPAYX_CLIENT, type RazorpayXClient, type RazorpayXPayout } from "./razorpayx.client";

export const PAYOUT_LEDGER_REF = "PAYOUT";
export const PAYOUT_REQUEST_DESCRIPTION = "payout_request";
export const PAYOUT_REJECT_DESCRIPTION = "payout_reject";
export const PAYOUT_SETTLED_DESCRIPTION = "payout_settled";
export const PAYOUT_FAILED_DESCRIPTION = "payout_failed";
export const PAYOUT_REVERSED_DESCRIPTION = "payout_reversed";
export const PAYOUT_SEND_JOB = "payout.send";
/** An APPROVED payout RazorpayX has not been asked about for this long was not sent (outage, crash): the maintenance job picks it up. */
export const PAYOUT_REDRIVE_AFTER_MS = 5 * 60 * 1000;
/** IMPS carries up to INR 5,00,000; above that the payout goes by NEFT. */
export const IMPS_LIMIT_PAISE = 50_000_000n;

export const SYSTEM_ACTOR = "system";

export interface PayoutView {
  id: string;
  ownerType: "USER" | "ORG";
  ownerId: string;
  status: PayoutStatus;
  mode: PayoutMode;
  amountPaise: string;
  /** Tax withheld at the rate in force when the payout was requested. */
  tdsPaise: string;
  tdsBps: number;
  /** What reaches the bank: amount minus TDS. */
  netPaise: string;
  currency: "INR";
  utr: string | null;
  failureReason: string | null;
  requestedBy: string;
  approvedBy: string | null;
  createdAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  destination: PayoutDestination | null;
}

/** Where the money goes: masked details of the account snapshotted on the payout. `reviewFlag` is for finance only. */
export interface PayoutDestination {
  type: "BANK" | "UPI";
  ifsc: string | null;
  accountLast4: string | null;
  vpaMasked: string | null;
  status: "PENDING" | "VERIFIED" | "FAILED" | "INACTIVE";
  reviewFlag?: string | null;
}

export const netOf = (p: Pick<Payout, "amountPaise" | "tdsPaise">): bigint => p.amountPaise - p.tdsPaise;

type AccountForView = Pick<PayoutAccount, "type" | "ifsc" | "accountLast4" | "vpaMasked" | "status" | "reviewFlag">;
const destinationOf = (a: AccountForView | undefined, admin: boolean): PayoutDestination | null =>
  a ? { type: a.type, ifsc: a.ifsc, accountLast4: a.accountLast4, vpaMasked: a.vpaMasked, status: a.status, ...(admin ? { reviewFlag: a.reviewFlag } : {}) } : null;

export const toPayoutView = (p: Payout, account?: AccountForView, admin = false): PayoutView => ({
  id: p.id,
  ownerType: p.ownerType,
  ownerId: p.ownerId,
  status: p.status,
  mode: p.mode,
  amountPaise: toApi(p.amountPaise),
  tdsPaise: toApi(p.tdsPaise),
  tdsBps: p.tdsBps,
  netPaise: toApi(netOf(p)),
  currency: "INR",
  utr: p.utr,
  failureReason: p.failureReason,
  requestedBy: p.requestedBy,
  approvedBy: p.approvedBy,
  createdAt: p.createdAt.toISOString(),
  approvedAt: p.approvedAt?.toISOString() ?? null,
  paidAt: p.paidAt?.toISOString() ?? null,
  destination: destinationOf(account, admin),
});

/** What a payout.* webhook says about the payout. */
export interface PayoutWebhookEntity {
  id: string;
  /** Our payout id: set as reference_id when the payout was created. */
  referenceId: string | null;
  amountPaise: bigint | null;
  utr: string | null;
  failureReason: string | null;
}

/**
 * Provider error text can carry internal detail, so what is stored on the payout and shown to the creator is one of three codes. The raw text
 * goes only to the finance alert (and Sentry).
 */
export type FailureCode = "BANK_REJECTED" | "INVALID_ACCOUNT" | "PROVIDER_ERROR";
export function failureCodeOf(raw: string | null | undefined): FailureCode {
  const text = (raw ?? "").toLowerCase();
  if (/invalid|ifsc|closed|blocked|frozen|dormant|beneficiary account|account (does not|not)|no such account/.test(text)) return "INVALID_ACCOUNT";
  if (/reject|declin|bank|returned|failed/.test(text)) return "BANK_REJECTED";
  return "PROVIDER_ERROR";
}

const notPending = () => new AppError("PAYOUT_NOT_PENDING", 409, "This payout has already been decided");
const isFourXx = (err: unknown) => err instanceof RazorpayApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

/**
 * Payouts: request (locks the funds), approval (finance), sending (RazorpayX, outside any database transaction) and settlement from the
 * RazorpayX webhooks. Every state change is a conditional update under a row lock, and every ledger entry is keyed (PAYOUT, payoutId,
 * <step>), so a repeated request, approval, job or webhook can neither move money twice nor undo a later state.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly payoutAccounts: PayoutAccountsService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly alerts: FinanceAlerts,
    @Inject(RAZORPAYX_CLIENT) private readonly razorpayx: RazorpayXClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.billing) private readonly queue: Queue,
  ) {}

  // ── Request ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Locks `amountPaise` of the owner's AVAILABLE balance for a payout to their verified account. The balance check is the ledger's
   * `nonNegative` rule applied under the balance row lock, so two concurrent requests for the same money cannot both succeed, and an
   * AVAILABLE balance that a late refund pushed to zero or below blocks payouts. TDS is worked out now at the current rate and frozen on the row.
   */
  async request(owner: Owner, actorId: string, amountPaise: bigint): Promise<PayoutView> {
    const minPaise = BigInt(await this.settings.get("min_payout_paise"));
    if (amountPaise <= 0n || amountPaise < minPaise) {
      throw new AppError("PAYOUT_BELOW_MINIMUM", 422, "The amount is below the minimum payout", { minPaise: toApi(minPaise) });
    }
    const tdsBps = await this.settings.get("tds_bps");
    const tdsPaise = (amountPaise * BigInt(tdsBps)) / 10_000n; // floor
    const netPaise = amountPaise - tdsPaise;
    if (netPaise <= 0n) throw new AppError("PAYOUT_BELOW_MINIMUM", 422, "Nothing would be paid out after tax", { minPaise: toApi(minPaise) });

    const payout = await this.prisma.$transaction(async (tx) => {
      // The same per-owner lock the payout account change takes: an account cannot be swapped between the check and the insert.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-owner:${owner.ownerType}:${owner.ownerId}`}))`;
      const account = await this.payoutAccounts.payableAccount(owner, tx);
      if (account.type === "UPI") {
        const upiMax = BigInt(await this.settings.get("upi_max_payout_paise"));
        if (netPaise > upiMax) throw new AppError("PAYOUT_ABOVE_UPI_LIMIT", 422, "This amount is above the UPI limit; use a bank account for larger payouts", { maxPaise: toApi(upiMax) });
      }
      const seller = await this.accounts.ensureSellerAccounts(tx, owner.ownerType, owner.ownerId);
      const created = await tx.payout.create({
        data: {
          id: uuidv7(),
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          payoutAccountId: account.id,
          amountPaise,
          tdsBps,
          tdsPaise,
          mode: account.type === "UPI" ? "UPI" : netPaise <= IMPS_LIMIT_PAISE ? "IMPS" : "NEFT",
          requestedBy: actorId,
        },
      });
      await this.ledger.post(tx, {
        refType: PAYOUT_LEDGER_REF,
        refId: created.id,
        description: PAYOUT_REQUEST_DESCRIPTION,
        lines: [
          { accountId: seller.AVAILABLE, amountPaise: -amountPaise },
          { accountId: seller.PAYOUT_LOCKED, amountPaise },
        ],
        nonNegative: [seller.AVAILABLE],
      });
      await this.outbox.enqueue(tx, this.event("payout.requested", created));
      return created;
    });
    this.logger.log(`payout ${payout.id} requested by ${actorId} for ${owner.ownerType}:${owner.ownerId}`);
    return this.viewOf(payout);
  }

  private event<T extends "payout.requested" | "payout.approved" | "payout.rejected" | "payout.settled" | "payout.failed">(type: T, p: Payout, extra: Record<string, unknown> = {}) {
    return { type, payoutId: p.id, ownerType: p.ownerType, ownerId: p.ownerId, requestedBy: p.requestedBy, amountPaise: toApi(p.amountPaise), tdsPaise: toApi(p.tdsPaise), netPaise: toApi(netOf(p)), ...extra } as Extract<
      import("../../common/outbox/events").DomainEvent,
      { type: T }
    >;
  }

  // ── Decision ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Finance approves. The decision and its audit row commit together (conditional on REQUESTED, under the row lock); the RazorpayX call
   * happens later in the `payout.send` job (jobId = payout id, so one job per payout). Approving an APPROVED payout again only makes sure
   * the job exists; a payout already underway or settled is returned as it is.
   */
  async approve(actorId: string, payoutId: string, meta: MutationMeta = {}): Promise<PayoutView> {
    const { payout, enqueue } = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockAndLoad(tx, payoutId);
      if (current.status === "REQUESTED" && current.requestedBy === actorId) throw new AppError("PAYOUT_SELF_APPROVAL", 403, "A payout cannot be approved by the person who requested it");
      if (current.status === "REQUESTED" || current.status === "APPROVED") {
        const blocked = await this.accountBlock(tx, current);
        if (blocked) {
          const rejected = await this.autoReject(tx, current, blocked, actorId, meta);
          return { payout: rejected, enqueue: false };
        }
      }
      if (current.status === "REQUESTED") {
        const approved = await tx.payout.update({ where: { id: current.id }, data: { status: "APPROVED", approvedBy: actorId, approvedAt: this.clock.now() } });
        await this.audit.record(tx, { actorId, action: "payout.approve", targetType: "payout", targetId: current.id, before: toPayoutView(current), after: toPayoutView(approved), ...meta });
        await this.outbox.enqueue(tx, this.event("payout.approved", approved));
        return { payout: approved, enqueue: true };
      }
      if (current.status === "APPROVED") return { payout: current, enqueue: true };
      if (current.status === "PROCESSING" || current.status === "PAID") return { payout: current, enqueue: false };
      throw notPending();
    });
    if (enqueue) await this.enqueueSend(payout.id);
    return this.viewOf(payout, true);
  }

  /** Why the payout's snapshotted account may no longer be paid (replaced, unverified, held for review, in cooldown), or null. */
  private async accountBlock(tx: Prisma.TransactionClient, p: Payout): Promise<string | null> {
    const account = await tx.payoutAccount.findUnique({ where: { id: p.payoutAccountId } });
    return account ? this.payoutAccounts.blockReason(account) : "the payout account no longer exists";
  }

  /**
   * The payout cannot go to its account any more: it is REJECTED with reason PAYOUT_ACCOUNT_CHANGED and the locked funds return to AVAILABLE
   * (entry payout_reject), so the creator re-requests against the current account. Runs under the payout row lock; `why` is for the log only.
   */
  private async autoReject(tx: Prisma.TransactionClient, current: Payout, why: string, actorId: string, meta: MutationMeta = {}): Promise<Payout> {
    const seller = await this.accounts.ensureSellerAccounts(tx, current.ownerType, current.ownerId);
    await this.unlock(tx, current, seller, PAYOUT_REJECT_DESCRIPTION);
    const updated = await tx.payout.update({ where: { id: current.id }, data: { status: "REJECTED", failureReason: "PAYOUT_ACCOUNT_CHANGED" } });
    await this.audit.record(tx, { actorId: actorId === SYSTEM_ACTOR ? null : actorId, action: "payout.auto_reject", targetType: "payout", targetId: current.id, before: toPayoutView(current), after: { ...toPayoutView(updated), why }, ...meta });
    await this.outbox.enqueue(tx, this.event("payout.rejected", updated, { note: "PAYOUT_ACCOUNT_CHANGED" }));
    this.logger.warn(`payout ${current.id} rejected automatically: ${why}`);
    return updated;
  }

  private async viewOf(p: Payout, admin = false): Promise<PayoutView> {
    const account = await this.prisma.payoutAccount.findUnique({ where: { id: p.payoutAccountId } });
    return toPayoutView(p, account ?? undefined, admin);
  }

  /** Finance rejects a REQUESTED payout: the locked funds go back to AVAILABLE. */
  async reject(actorId: string, payoutId: string, note: string | undefined, meta: MutationMeta = {}): Promise<PayoutView> {
    const rejected = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockAndLoad(tx, payoutId);
      if (current.status !== "REQUESTED") throw notPending();
      const seller = await this.accounts.ensureSellerAccounts(tx, current.ownerType, current.ownerId);
      await this.unlock(tx, current, seller, PAYOUT_REJECT_DESCRIPTION);
      const updated = await tx.payout.update({ where: { id: current.id }, data: { status: "REJECTED", approvedBy: actorId, approvedAt: this.clock.now(), failureReason: note?.slice(0, 500) ?? null } });
      await this.audit.record(tx, { actorId, action: "payout.reject", targetType: "payout", targetId: current.id, before: toPayoutView(current), after: { ...toPayoutView(updated), note: note ?? null }, ...meta });
      await this.outbox.enqueue(tx, this.event("payout.rejected", updated, { note: note ?? null }));
      return updated;
    });
    return this.viewOf(rejected, true);
  }

  private async lockAndLoad(tx: Prisma.TransactionClient, payoutId: string): Promise<Payout> {
    await tx.$queryRaw`SELECT "id" FROM "payouts" WHERE "id" = ${payoutId} FOR UPDATE`;
    const payout = await tx.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new AppError("PAYOUT_NOT_FOUND", 404, "Payout not found");
    return payout;
  }

  /** PAYOUT_LOCKED -> AVAILABLE for the whole amount (the funds never left). */
  private async unlock(tx: Prisma.TransactionClient, p: Payout, seller: { AVAILABLE: string; PAYOUT_LOCKED: string }, description: string) {
    await this.ledger.post(tx, {
      refType: PAYOUT_LEDGER_REF,
      refId: p.id,
      description,
      lines: [
        { accountId: seller.PAYOUT_LOCKED, amountPaise: -p.amountPaise },
        { accountId: seller.AVAILABLE, amountPaise: p.amountPaise },
      ],
    });
  }

  private async enqueueSend(payoutId: string): Promise<void> {
    try {
      await this.queue.add(PAYOUT_SEND_JOB, { payoutId }, { jobId: `payout-send-${payoutId}`, removeOnComplete: true });
    } catch (err) {
      // The decision is stored; the maintenance job re-drives an APPROVED payout nobody sent.
      this.logger.error(`could not queue the send of payout ${payoutId}: ${(err as Error).message}`);
    }
  }

  // ── Sending ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Creates the payout at RazorpayX for an APPROVED payout (the NET amount, reference id and idempotency key = the payout id), outside any
   * database transaction, then stores PROCESSING + the RazorpayX id with a conditional update. With `recover` the RazorpayX payout for this
   * reference is looked up first and adopted if it exists (a crash after the call). A definitive refusal (4xx) fails the payout and returns
   * the funds; an outage throws so the job is retried.
   */
  async send(payoutId: string, opts: { recover?: boolean } = {}): Promise<Payout> {
    const payout = await this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    if (payout.status !== "APPROVED" || payout.razorpayxPayoutId) return payout;
    const account = await this.prisma.payoutAccount.findUniqueOrThrow({ where: { id: payout.payoutAccountId } });
    // The destination is re-checked at the last moment: if it was replaced or flagged since the approval, nothing is sent and the funds go back.
    const blocked = this.payoutAccounts.blockReason(account);
    const rejectBlocked = (why: string) =>
      this.prisma.$transaction(async (tx) => {
        const current = await this.lockAndLoad(tx, payout.id);
        if (current.status !== "APPROVED" || current.razorpayxPayoutId) return current;
        return this.autoReject(tx, current, why, SYSTEM_ACTOR);
      });
    if (blocked && !opts.recover) return rejectBlocked(blocked);

    let remote: RazorpayXPayout | null = null;
    try {
      if (opts.recover) remote = await this.razorpayx.findPayoutByReference(payout.id);
      // A payout RazorpayX already has is adopted either way; a new one is not created for a destination that is no longer allowed.
      if (!remote && blocked) return await rejectBlocked(blocked);
      if (!remote) {
        remote = await this.razorpayx.createPayout({
          fundAccountId: account.razorpayxFundAccountId,
          amountPaise: netOf(payout),
          mode: payout.mode,
          referenceId: payout.id,
          idempotencyKey: payout.id,
          narration: "Skiller payout",
        });
      }
    } catch (err) {
      if (!isFourXx(err)) {
        this.logger.error(`payout ${payout.id}: RazorpayX is unavailable (${(err as Error).message}); it stays APPROVED for a retry`);
        throw new AppError("PAYOUT_GATEWAY_ERROR", 502, "The payout provider is unavailable; the payout will be retried");
      }
      // A 4xx can also mean "this payout already exists": ask RazorpayX before declaring failure; if even that fails, treat it as an outage.
      try {
        remote = await this.razorpayx.findPayoutByReference(payout.id);
      } catch (lookupErr) {
        this.logger.error(`payout ${payout.id}: RazorpayX refused (${(err as Error).message}) and the lookup failed (${(lookupErr as Error).message}); it stays APPROVED`);
        throw new AppError("PAYOUT_GATEWAY_ERROR", 502, "The payout provider is unavailable; the payout will be retried");
      }
      if (!remote) {
        await this.failUnsent(payout.id, (err as Error).message);
        return this.prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
      }
      this.logger.warn(`payout ${payout.id}: adopting RazorpayX payout ${remote.id} that already exists for it`);
    }
    await this.prisma.payout.updateMany({ where: { id: payout.id, status: "APPROVED", razorpayxPayoutId: null }, data: { status: "PROCESSING", razorpayxPayoutId: remote.id } });
    return this.prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
  }

  /** RazorpayX refused for good before anything was created: the payout FAILS and the funds go back to AVAILABLE. */
  private async failUnsent(payoutId: string, why: string): Promise<void> {
    const failed = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockAndLoad(tx, payoutId);
      if (current.status !== "APPROVED" || current.razorpayxPayoutId) return null;
      const seller = await this.accounts.ensureSellerAccounts(tx, current.ownerType, current.ownerId);
      await this.unlock(tx, current, seller, PAYOUT_FAILED_DESCRIPTION);
      const updated = await tx.payout.update({ where: { id: current.id }, data: { status: "FAILED", failureReason: failureCodeOf(why) } });
      await this.outbox.enqueue(tx, this.event("payout.failed", updated, { outcome: "FAILED", reason: failureCodeOf(why) }));
      return updated;
    });
    if (failed) await this.alertFailed(failed, why);
  }

  /** Sends APPROVED payouts that never reached RazorpayX (older than 5 minutes, measured on the Clock). Returns how many were started. */
  async redriveStuck(limit = 50): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - PAYOUT_REDRIVE_AFTER_MS);
    const stuck = await this.prisma.payout.findMany({ where: { status: "APPROVED", razorpayxPayoutId: null, approvedAt: { lt: cutoff } }, orderBy: { id: "asc" }, take: limit });
    let started = 0;
    for (const p of stuck) {
      try {
        const after = await this.send(p.id, { recover: true });
        if (after.status === "PROCESSING") started += 1;
      } catch (err) {
        this.logger.warn(`payout ${p.id} could not be started yet: ${(err as Error).message}`);
      }
    }
    return started;
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Finds our payout for a webhook: by the RazorpayX payout id, or - when the id was never stored (a crash between RazorpayX accepting the
   * payout and us recording it) - by the reference id (= our payout id), adopting the RazorpayX id. Anything else throws, so the queue retries.
   */
  private async locate(entity: PayoutWebhookEntity): Promise<{ id: string }> {
    const byId = await this.prisma.payout.findUnique({ where: { razorpayxPayoutId: entity.id }, select: { id: true } });
    if (byId) return byId;
    if (entity.referenceId) {
      const candidate = await this.prisma.payout.findUnique({ where: { id: entity.referenceId }, select: { id: true, razorpayxPayoutId: true, status: true } });
      if (candidate && !candidate.razorpayxPayoutId && ["APPROVED", "PROCESSING"].includes(candidate.status)) {
        const adopted = await this.prisma.payout.updateMany({ where: { id: candidate.id, razorpayxPayoutId: null }, data: { razorpayxPayoutId: entity.id } });
        if (adopted.count === 1) this.logger.warn(`payout ${candidate.id}: adopted RazorpayX payout ${entity.id} from the webhook reference`);
        return { id: candidate.id };
      }
    }
    throw new Error(`unknown payout ${entity.id}: not stored yet, will retry`);
  }

  /**
   * payout.processed: the money reached the bank. PAYOUT_LOCKED -amount / GATEWAY_CLEARING +(amount - tds) / TAX_PAYABLE +tds, status PAID.
   * Only an APPROVED / PROCESSING payout settles; a repeat finds PAID, a late event for a payout already reversed or failed is ignored.
   */
  async onProcessed(entity: PayoutWebhookEntity): Promise<void> {
    const known = await this.locate(entity);
    let mismatch: Payout | null = null;
    await this.prisma.$transaction(
      async (tx) => {
        const p = await this.lockAndLoad(tx, known.id);
        if (p.status === "PAID" || p.status === "MANUAL_REVIEW") return;
        if (p.status === "REVERSED" || p.status === "FAILED" || p.status === "REJECTED") {
          this.logger.warn(`payout ${p.id}: processed event ignored, the payout is already ${p.status}`);
          return;
        }
        if (p.status === "REQUESTED") throw new Error(`payout ${p.id} was processed by RazorpayX but never approved`);
        if (entity.amountPaise === null || entity.amountPaise !== netOf(p)) {
          // Settle nothing and stop: the funds stay locked, the payout waits for finance, and the event is done (no retry loop).
          await tx.payout.update({ where: { id: p.id }, data: { status: "MANUAL_REVIEW", failureReason: "AMOUNT_MISMATCH", ...(p.razorpayxPayoutId ? {} : { razorpayxPayoutId: entity.id }) } });
          mismatch = p;
          return;
        }
        const seller = await this.accounts.ensureSellerAccounts(tx, p.ownerType, p.ownerId);
        const clearing = await this.accounts.platformAccount("GATEWAY_CLEARING", tx);
        const net = netOf(p);
        const lines = [
          { accountId: seller.PAYOUT_LOCKED, amountPaise: -p.amountPaise },
          { accountId: clearing, amountPaise: net },
          ...(p.tdsPaise > 0n ? [{ accountId: await this.accounts.platformAccount("TAX_PAYABLE", tx), amountPaise: p.tdsPaise }] : []),
        ];
        await this.ledger.post(tx, { refType: PAYOUT_LEDGER_REF, refId: p.id, description: PAYOUT_SETTLED_DESCRIPTION, lines });
        const paid = await tx.payout.update({ where: { id: p.id }, data: { status: "PAID", paidAt: this.clock.now(), utr: entity.utr, ...(p.razorpayxPayoutId ? {} : { razorpayxPayoutId: entity.id }) } });
        await this.outbox.enqueue(tx, this.event("payout.settled", paid, { utr: entity.utr }));
        this.logger.log(`payout ${p.id} paid`);
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    if (mismatch) {
      const p: Payout = mismatch;
      await this.alerts.raise({
        kind: "PAYOUT_AMOUNT_MISMATCH",
        message: `RazorpayX reports payout ${entity.id} (our payout ${p.id}) processed for ${entity.amountPaise ?? "an unknown amount"} paise but we sent ${netOf(p)}. Nothing was settled and the payout is in MANUAL_REVIEW: reconcile it by hand.`,
        dedupeKey: `payout-mismatch:${p.id}`,
        link: "/admin/payouts",
        data: { payoutId: p.id },
      });
    }
  }

  /**
   * payout.reversed / payout.failed / payout.rejected: the money is coming back. Before settlement the locked funds return to AVAILABLE; after
   * it (a reversal of a PAID payout) the settlement is undone: GATEWAY_CLEARING -net, TAX_PAYABLE -tds, AVAILABLE +amount. `reversed` ends
   * REVERSED, `failed`/`rejected` end FAILED. Terminal states are never changed again.
   */
  async onReturned(entity: PayoutWebhookEntity, kind: "reversed" | "failed" | "rejected"): Promise<void> {
    const known = await this.locate(entity);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const p = await this.lockAndLoad(tx, known.id);
        if (p.status === "REVERSED" || p.status === "FAILED" || p.status === "REJECTED") return null;
        if (p.status === "REQUESTED") throw new Error(`payout ${p.id} was ${kind} by RazorpayX but never approved`);
        const seller = await this.accounts.ensureSellerAccounts(tx, p.ownerType, p.ownerId);
        const rawReason = (entity.failureReason ?? `RazorpayX reported the payout ${kind}`).slice(0, 500);
        const reason = failureCodeOf(rawReason);
        const wasPaid = p.status === "PAID";
        if (wasPaid) {
          const clearing = await this.accounts.platformAccount("GATEWAY_CLEARING", tx);
          await this.ledger.post(tx, {
            refType: PAYOUT_LEDGER_REF,
            refId: p.id,
            description: PAYOUT_REVERSED_DESCRIPTION,
            lines: [
              { accountId: clearing, amountPaise: -netOf(p) },
              ...(p.tdsPaise > 0n ? [{ accountId: await this.accounts.platformAccount("TAX_PAYABLE", tx), amountPaise: -p.tdsPaise }] : []),
              { accountId: seller.AVAILABLE, amountPaise: p.amountPaise },
            ],
          });
        } else {
          await this.unlock(tx, p, seller, kind === "reversed" ? PAYOUT_REVERSED_DESCRIPTION : PAYOUT_FAILED_DESCRIPTION);
        }
        const outcome = kind === "reversed" ? "REVERSED" : "FAILED";
        const updated = await tx.payout.update({ where: { id: p.id }, data: { status: outcome, failureReason: reason, utr: entity.utr ?? p.utr, ...(p.razorpayxPayoutId ? {} : { razorpayxPayoutId: entity.id }) } });
        await this.outbox.enqueue(tx, this.event("payout.failed", updated, { outcome, reason }));
        this.logger.log(`payout ${p.id} ${outcome}${wasPaid ? " after settlement" : ""}`);
        return { updated, reason: rawReason, wasPaid };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    if (result) await this.alertFailed(result.updated, result.wasPaid ? `${result.reason} (reversed after it was marked paid)` : result.reason);
  }

  private async alertFailed(p: Payout, why: string): Promise<void> {
    await this.alerts.raise({
      kind: "PAYOUT_FAILED",
      message: `Payout ${p.id} of ${toApi(p.amountPaise)} paise to ${p.ownerType} ${p.ownerId} did not complete: ${why}. The funds are back in the seller's AVAILABLE balance.`,
      dedupeKey: `payout-failed:${p.id}`,
      link: "/admin/payouts",
      data: { payoutId: p.id },
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  async listFor(owner: Owner, page: PageQuery) {
    return this.list({ ownerType: owner.ownerType, ownerId: owner.ownerId }, page);
  }

  async list(filter: { ownerType?: "USER" | "ORG"; ownerId?: string; status?: PayoutStatus; createdAt?: { gte?: Date; lt?: Date } }, page: PageQuery, admin = false) {
    const rows = await this.prisma.payout.findMany({
      where: { ...(filter.createdAt ? { createdAt: filter.createdAt } : {}), ...(filter.ownerType ? { ownerType: filter.ownerType } : {}), ...(filter.ownerId ? { ownerId: filter.ownerId } : {}), ...(filter.status ? { status: filter.status } : {}), ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    const accounts = await this.prisma.payoutAccount.findMany({ where: { id: { in: [...new Set(items.map((p) => p.payoutAccountId))] } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return { items: items.map((p) => toPayoutView(p, byId.get(p.payoutAccountId), admin)), nextCursor };
  }

  /** Finance's view of one payout, with its destination account and that account's status and review flag. */
  async get(id: string): Promise<PayoutView> {
    const p = await this.prisma.payout.findUnique({ where: { id } });
    if (!p) throw new AppError("PAYOUT_NOT_FOUND", 404, "Payout not found");
    return this.viewOf(p, true);
  }
}
