import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type ReconciliationRun, type ReconciliationStatus } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { LedgerIntegrity } from "../wallet";
import { FinanceAlerts } from "./finance-alerts.service";
import { ORDER_LEDGER_REF, SALE_DESCRIPTION } from "./fulfilment.service";
import { istDayRange } from "./ist";
import { toApi } from "./money";
import { PayoutsService, type PayoutWebhookEntity } from "./payouts.service";
import { RAZORPAY_CLIENT, RazorpayApiError, type RazorpayClient, type RazorpayPayment } from "./razorpay.client";
import { RAZORPAYX_CLIENT, type RazorpayXClient } from "./razorpayx.client";
import { REFUND_DESCRIPTION, RefundsService } from "./refunds.service";
import { SUBSCRIPTION_CHARGE_REF } from "./subscriptions.service";

/** A payout or refund still PROCESSING after this long has probably missed its webhook: ask the provider. */
export const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;
/** Items listed per section; the counts are always complete. */
const MAX_ITEMS = 200;
const STUCK_BATCH = 100;

export interface ReconciliationRunView {
  id: string;
  date: string;
  status: ReconciliationStatus;
  details: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

export const toRunView = (r: ReconciliationRun): ReconciliationRunView => ({
  id: r.id,
  date: r.date,
  status: r.status,
  details: r.details as Record<string, unknown>,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

type Item = Record<string, string | number | null>;

interface Capped {
  items: Item[];
  /** How many items were found in all; `items` holds at most MAX_ITEMS of them. */
  total: number;
}
const cap = (items: Item[]): Capped => ({ items: items.slice(0, MAX_ITEMS), total: items.length });

const stuckError = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Nightly reconciliation of one IST calendar day (spec 12): the gateway against the books, the books against themselves, and stuck
 * payouts / refunds against their providers. Results are stored in `reconciliation_runs` (one row per date; a rerun updates it).
 * Any MISMATCH or ERROR alerts finance (notifications + Sentry).
 *
 *  1. stuck states first, so the checks below see the books after any lost webhook was applied: a RazorpayX payout or a Razorpay refund
 *     PROCESSING for more than 2 h is fetched and its terminal status applied through the SAME handlers the webhooks use;
 *  2. payments: Razorpay's captured payments of the day against PAID/REFUNDED orders and subscription charges (by payment id and amount);
 *  3. settlements: a failed settlement, or settled money larger than everything the books ever took in, is flagged;
 *  4. ledger invariants, in SQL: all lines sum to 0, every account_balances row equals its lines, every entry of the day sums to 0.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAZORPAY_CLIENT) private readonly razorpay: RazorpayClient,
    @Inject(RAZORPAYX_CLIENT) private readonly razorpayx: RazorpayXClient,
    private readonly integrity: LedgerIntegrity,
    private readonly payouts: PayoutsService,
    private readonly refunds: RefundsService,
    private readonly alerts: FinanceAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(date: string): Promise<ReconciliationRunView> {
    let range: { from: Date; to: Date };
    try {
      range = istDayRange(date);
    } catch {
      throw new AppError("RECONCILIATION_DATE_INVALID", 400, "date must be a calendar day, YYYY-MM-DD (India time)");
    }
    const startedAt = this.clock.now();
    const errors: { section: string; message: string }[] = [];
    const guarded = async <T>(section: string, fallback: T, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (err) {
        this.logger.error(`reconciliation ${date}: ${section} failed: ${(err as Error).message}`);
        errors.push({ section, message: stuckError(err) });
        return fallback;
      }
    };

    const stuck = await guarded("stuck", { payouts: [] as Item[], refunds: [] as Item[] }, () => this.resolveStuck(errors));
    const payments = await guarded("payments", { gatewayCount: 0, booksCount: 0, ...cap([]) }, () => this.checkPayments(range));
    const settlements = await guarded("settlements", { count: 0, grossPaise: "0", ...cap([]) }, () => this.checkSettlements(range));
    const ledger = await guarded("ledger", { totalPaise: "0", drift: [] as Item[], unbalancedEntries: [] as Item[] }, () => this.checkLedger(range));

    const mismatches = payments.total + settlements.total + (ledger.totalPaise === "0" ? 0 : 1) + ledger.drift.length + ledger.unbalancedEntries.length;
    const status: ReconciliationStatus = mismatches > 0 ? "MISMATCH" : errors.length > 0 ? "ERROR" : "OK";
    const details = { date, window: { from: range.from.toISOString(), to: range.to.toISOString() }, payments, settlements, ledger, stuck, errors } as unknown as Prisma.InputJsonValue;
    const finishedAt = this.clock.now();

    const saved = await this.save(date, { status, details, startedAt, finishedAt });
    if (status !== "OK") {
      const parts = [
        payments.total && `${payments.total} payment mismatch(es)`,
        settlements.total && `${settlements.total} settlement mismatch(es)`,
        ledger.totalPaise !== "0" && `ledger total is ${ledger.totalPaise} paise instead of 0`,
        ledger.drift.length && `${ledger.drift.length} account balance(s) differ from their lines`,
        ledger.unbalancedEntries.length && `${ledger.unbalancedEntries.length} unbalanced entr(ies)`,
        errors.length && `${errors.length} check(s) could not run (${errors.map((e) => e.section).join(", ")})`,
      ].filter(Boolean);
      await this.alerts.raise({
        kind: status === "ERROR" ? "RECONCILIATION_ERROR" : "RECONCILIATION_MISMATCH",
        message: `Reconciliation for ${date} (India time) found: ${parts.join("; ")}.`,
        dedupeKey: `reconciliation:${date}:${status}`,
        link: "/admin/finance/reconciliation",
        data: { date, runId: saved.id, status },
      });
    }
    this.logger.log(`reconciliation ${date}: ${status}`);
    return toRunView(saved);
  }

  private async save(date: string, data: { status: ReconciliationStatus; details: Prisma.InputJsonValue; startedAt: Date; finishedAt: Date }): Promise<ReconciliationRun> {
    try {
      return await this.prisma.reconciliationRun.upsert({ where: { date }, create: { date, ...data }, update: data });
    } catch (err) {
      // Two runs of the same day created the row at the same moment: the second one just updates it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return this.prisma.reconciliationRun.update({ where: { date }, data });
      throw err;
    }
  }

  async list(page: PageQuery): Promise<{ items: ReconciliationRunView[]; nextCursor: string | null }> {
    const rows = await this.prisma.reconciliationRun.findMany({ where: page.cursor ? { date: { lt: page.cursor } } : {}, orderBy: { date: "desc" }, take: page.limit + 1 });
    const items = rows.slice(0, page.limit);
    return { items: items.map(toRunView), nextCursor: rows.length > page.limit ? items[items.length - 1].date : null };
  }

  // ── 1. stuck payouts and refunds ───────────────────────────────────────────────────────────────────────────────────

  private async resolveStuck(errors: { section: string; message: string }[]): Promise<{ payouts: Item[]; refunds: Item[] }> {
    const cutoff = new Date(this.clock.now().getTime() - STUCK_AFTER_MS);
    const out = { payouts: [] as Item[], refunds: [] as Item[] };

    const payouts = await this.prisma.payout.findMany({ where: { status: "PROCESSING", razorpayxPayoutId: { not: null }, updatedAt: { lt: cutoff } }, orderBy: { id: "asc" }, take: STUCK_BATCH });
    for (const p of payouts) {
      try {
        const remote = await this.razorpayx.fetchPayout(p.razorpayxPayoutId!);
        const entity: PayoutWebhookEntity = { id: remote.id, referenceId: remote.referenceId, amountPaise: remote.amountPaise, utr: remote.utr, failureReason: remote.failureReason };
        if (remote.status === "processed") await this.payouts.onProcessed(entity);
        else if (remote.status === "reversed") await this.payouts.onReturned(entity, "reversed");
        else if (remote.status === "failed") await this.payouts.onReturned(entity, "failed");
        else if (remote.status === "rejected" || remote.status === "cancelled") await this.payouts.onReturned(entity, "rejected");
        else {
          out.payouts.push({ payoutId: p.id, outcome: "STILL_PROCESSING", providerStatus: remote.status });
          continue;
        }
        const after = await this.prisma.payout.findUniqueOrThrow({ where: { id: p.id }, select: { status: true } });
        out.payouts.push({ payoutId: p.id, outcome: after.status, providerStatus: remote.status });
      } catch (err) {
        errors.push({ section: `payout ${p.id}`, message: stuckError(err) });
        out.payouts.push({ payoutId: p.id, outcome: "ERROR" });
      }
    }

    const refunds = await this.prisma.refund.findMany({ where: { status: "PROCESSING", razorpayRefundId: { not: null }, updatedAt: { lt: cutoff } }, orderBy: { id: "asc" }, take: STUCK_BATCH });
    for (const r of refunds) {
      try {
        const remote = await this.razorpay.fetchRefund(r.razorpayRefundId!);
        const entity = { id: remote.id, paymentId: remote.paymentId, refundIdNote: remote.notes.refundId ?? r.id };
        if (remote.status === "processed") await this.refunds.onProcessed(entity);
        else if (remote.status === "failed") await this.refunds.onFailed(entity);
        else {
          out.refunds.push({ refundId: r.id, outcome: "STILL_PROCESSING", providerStatus: remote.status });
          continue;
        }
        const after = await this.prisma.refund.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } });
        out.refunds.push({ refundId: r.id, outcome: after.status, providerStatus: remote.status });
      } catch (err) {
        errors.push({ section: `refund ${r.id}`, message: stuckError(err) });
        out.refunds.push({ refundId: r.id, outcome: "ERROR" });
      }
    }
    return out;
  }

  // ── 2. payments ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async checkPayments(range: { from: Date; to: Date }): Promise<{ gatewayCount: number; booksCount: number } & Capped> {
    const gateway = await this.razorpay.listCapturedPayments({ fromUnix: Math.floor(range.from.getTime() / 1000), toUnix: Math.floor(range.to.getTime() / 1000) });
    const gatewayIds = gateway.map((p) => p.id);
    const items: Item[] = [];

    // What the books hold for the gateway's payments, whenever they were booked (a payment at 23:59:59 may be booked after midnight).
    const [orders, charges, duplicates] = await Promise.all([
      this.prisma.order.findMany({ where: { razorpayPaymentId: { in: gatewayIds } }, select: { id: true, status: true, totalPaise: true, razorpayPaymentId: true } }),
      this.subscriptionCharges(Prisma.sql`j."refId" = ANY(${gatewayIds}::text[])`),
      this.prisma.duplicatePayment.findMany({ where: { razorpayPaymentId: { in: gatewayIds } }, select: { razorpayPaymentId: true } }),
    ]);
    const orderByPayment = new Map(orders.map((o) => [o.razorpayPaymentId!, o]));
    const knownDuplicates = new Set(duplicates.map((d) => d.razorpayPaymentId));
    for (const g of gateway) {
      const order = orderByPayment.get(g.id);
      const charge = charges.get(g.id);
      if (order && (order.status === "PAID" || order.status === "REFUNDED")) {
        if (order.totalPaise !== g.amountPaise) items.push({ kind: "AMOUNT_MISMATCH", paymentId: g.id, orderId: order.id, gatewayPaise: toApi(g.amountPaise), booksPaise: toApi(order.totalPaise) });
      } else if (charge !== undefined) {
        if (charge !== g.amountPaise) items.push({ kind: "AMOUNT_MISMATCH", paymentId: g.id, gatewayPaise: toApi(g.amountPaise), booksPaise: toApi(charge) });
      } else if (!knownDuplicates.has(g.id)) {
        // Captured at Razorpay, never booked: a lost webhook, or money that arrived outside checkout.
        items.push({ kind: "UNRECORDED_PAYMENT", paymentId: g.id, gatewayPaise: toApi(g.amountPaise), ...(order ? { orderId: order.id, orderStatus: order.status } : {}) });
      }
    }

    // What the books hold for the day, against what the gateway listed. A payment missing from the list may only sit just across the
    // day boundary on Razorpay's clock, so it is looked up before it is called missing.
    const booked = await this.bookedInWindow(range);
    const listed = new Set(gatewayIds);
    for (const [paymentId, b] of booked) {
      if (listed.has(paymentId)) continue;
      const found = await this.lookup(paymentId);
      if (!found || !found.captured) items.push({ kind: "MISSING_AT_GATEWAY", paymentId, booksPaise: toApi(b.amountPaise), ...(b.orderId ? { orderId: b.orderId } : {}) });
      else if (found.amountPaise !== b.amountPaise) items.push({ kind: "AMOUNT_MISMATCH", paymentId, gatewayPaise: toApi(found.amountPaise), booksPaise: toApi(b.amountPaise) });
    }
    return { gatewayCount: gateway.length, booksCount: booked.size, ...cap(items) };
  }

  /** The payment at Razorpay, or null when Razorpay says it does not exist (a 4xx). Outages propagate: the section then reports ERROR. */
  private async lookup(paymentId: string): Promise<RazorpayPayment | null> {
    try {
      return await this.razorpay.fetchPayment(paymentId);
    } catch (err) {
      if (err instanceof RazorpayApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) return null;
      throw err;
    }
  }

  private async bookedInWindow(range: { from: Date; to: Date }): Promise<Map<string, { amountPaise: bigint; orderId?: string }>> {
    const booked = new Map<string, { amountPaise: bigint; orderId?: string }>();
    const orders = await this.prisma.order.findMany({
      where: { status: { in: ["PAID", "REFUNDED"] }, paidAt: { gte: range.from, lt: range.to }, razorpayPaymentId: { not: null } },
      select: { id: true, totalPaise: true, razorpayPaymentId: true },
    });
    for (const o of orders) booked.set(o.razorpayPaymentId!, { amountPaise: o.totalPaise, orderId: o.id });
    const charges = await this.subscriptionCharges(Prisma.sql`j."createdAt" >= ${range.from} AND j."createdAt" < ${range.to}`);
    for (const [paymentId, amountPaise] of charges) booked.set(paymentId, { amountPaise });
    return booked;
  }

  /** Subscription charges by payment id: the amount is what left GATEWAY_CLEARING. */
  private async subscriptionCharges(where: Prisma.Sql): Promise<Map<string, bigint>> {
    const rows = await this.prisma.$queryRaw<{ id: string; amount: bigint }[]>`
      SELECT j."refId" AS id, SUM(-l."amountPaise")::bigint AS amount
      FROM "journal_entries" j
      JOIN "ledger_lines" l ON l."entryId" = j."id"
      JOIN "ledger_accounts" a ON a."id" = l."accountId" AND a."kind" = 'GATEWAY_CLEARING'
      WHERE j."refType" = ${SUBSCRIPTION_CHARGE_REF} AND ${where}
      GROUP BY j."refId"`;
    return new Map(rows.map((r) => [r.id, r.amount]));
  }

  // ── 3. settlements ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Razorpay settles days after capture, so a day's settlements cannot be matched to that day's sales one for one. What can be checked
   * is that no settlement failed, and that the money settled (net + fees + tax) never exceeds what GATEWAY_CLEARING has taken in
   * (sales and subscription charges, less refunds) up to the end of the day.
   */
  private async checkSettlements(range: { from: Date; to: Date }): Promise<{ count: number; grossPaise: string } & Capped> {
    const settlements = await this.razorpay.listSettlements({ fromUnix: Math.floor(range.from.getTime() / 1000), toUnix: Math.floor(range.to.getTime() / 1000) });
    const items: Item[] = [];
    let gross = 0n;
    for (const s of settlements) {
      if (s.status === "failed") items.push({ kind: "SETTLEMENT_FAILED", settlementId: s.id, amountPaise: toApi(s.amountPaise) });
      else gross += s.amountPaise + s.feesPaise + s.taxPaise;
    }
    if (gross > 0n) {
      const rows = await this.prisma.$queryRaw<{ inflow: bigint | null }[]>`
        SELECT COALESCE(SUM(-l."amountPaise"), 0)::bigint AS inflow
        FROM "journal_entries" j
        JOIN "ledger_lines" l ON l."entryId" = j."id"
        JOIN "ledger_accounts" a ON a."id" = l."accountId" AND a."kind" = 'GATEWAY_CLEARING'
        WHERE j."createdAt" < ${range.to}
          AND ((j."refType" = ${ORDER_LEDGER_REF} AND j."description" IN (${SALE_DESCRIPTION}, ${REFUND_DESCRIPTION})) OR j."refType" = ${SUBSCRIPTION_CHARGE_REF})`;
      const booked = rows[0]?.inflow ?? 0n;
      if (gross > booked) items.push({ kind: "SETTLEMENT_EXCEEDS_BOOKED", settledPaise: toApi(gross), bookedPaise: toApi(booked) });
    }
    return { count: settlements.length, grossPaise: toApi(gross), ...cap(items) };
  }

  // ── 4. ledger invariants ───────────────────────────────────────────────────────────────────────────────────────────

  private async checkLedger(range: { from: Date; to: Date }): Promise<{ totalPaise: string; drift: Item[]; unbalancedEntries: Item[] }> {
    const [total, drift, unbalanced] = await Promise.all([this.integrity.totalPaise(), this.integrity.balanceDrift(MAX_ITEMS), this.integrity.unbalancedEntries(range.from, range.to, MAX_ITEMS)]);
    return {
      totalPaise: toApi(total),
      drift: drift.map((d) => ({ accountId: d.accountId, kind: d.kind, ownerType: d.ownerType, ownerId: d.ownerId, storedPaise: toApi(d.storedPaise), linesPaise: toApi(d.linesPaise) })),
      unbalancedEntries: unbalanced.map((u) => ({ entryId: u.entryId, refType: u.refType, refId: u.refId, description: u.description, sumPaise: toApi(u.sumPaise) })),
    };
  }
}
