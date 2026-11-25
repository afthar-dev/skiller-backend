import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Prisma, PlanVersion, Plan, Subscription, SubscriptionStatus } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import type { DomainEvent } from "../../common/outbox/events";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SettingsService } from "../admin";
import { NotificationsService } from "../notifications";
import { AccountsService, LedgerService } from "../wallet";
import { EntitlementsService, type Owner } from "./entitlements.service";
import { FinanceAlerts } from "./finance-alerts.service";
import { fromGatewayAmount, gstSplit } from "./money";
import { FREE_PLAN_KEY, type LimitKey, type PlanLimits } from "./plan-catalog";
import { RAZORPAY_CLIENT, RazorpayApiError, type RazorpayClient } from "./razorpay.client";
import { UsageRegistry } from "./usage.registry";
import type { WebhookEventContext } from "./webhook.dispatcher";

export const SUBSCRIPTION_CHARGE_REF = "SUBSCRIPTION_CHARGE";
/** PAST_DUE keeps the plan's access for this long (Review Focus 4). */
export const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
const ABANDONED_CHECKOUT_MS = 7 * 24 * 60 * 60 * 1000;
const REUSE_CHECKOUT_MS = 30 * 60 * 1000;
/** A paid ACTIVE subscription this long past its period end without a renewal is flagged to finance. */
const MISSED_RENEWAL_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const BATCH = 200;

type VersionWithPlan = PlanVersion & { plan: Plan };
type SubChange = Extract<DomainEvent, { type: "subscription.changed" }>["change"];

export interface CheckoutResult {
  subscriptionId: string;
  razorpaySubscriptionId: string;
  keyId: string;
}

export type ChangeResult =
  | ({ effective: "ON_PAYMENT" } & CheckoutResult)
  | { effective: "AT_PERIOD_END"; subscriptionId: string; scheduledPlanVersionId: string; effectiveAt: string | null };

export interface UsageView {
  used: number | null;
  limit: number | null;
  unit: "bytes" | "count";
}

export interface MySubscriptionView {
  subscriptionId: string | null;
  plan: { key: string; versionId: string; commissionBps: number };
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: string | null;
  scheduledPlanVersionId: string | null;
  limits: PlanLimits;
  usage: Partial<Record<LimitKey, UsageView>>;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const entityOf = (body: Record<string, unknown>, name: string): Record<string, unknown> | undefined => asRecord(asRecord(asRecord(body.payload)?.[name])?.entity);
const unixToDate = (v: unknown): Date | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null);
/** Plan price normalised to a year, so monthly and yearly versions compare. */
const yearlyValue = (v: { pricePaise: bigint; interval: "MONTH" | "YEAR" }): bigint => (v.interval === "MONTH" ? v.pricePaise * 12n : v.pricePaise);

const USAGE_UNIT: Partial<Record<LimitKey, UsageView["unit"]>> = { storage_gb: "bytes", max_published_courses: "count", reels_per_day: "count", org_seats: "count", max_active_gigs: "count" };

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAZORPAY_CLIENT) private readonly razorpay: RazorpayClient,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageRegistry,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly alerts: FinanceAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Free rows ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Idempotent (a partial unique index allows one gateway-less ACTIVE row per owner and the insert skips duplicates). */
  async ensureFree(tx: Prisma.TransactionClient, owner: Owner, notifyUserId?: string | null): Promise<void> {
    const version = await tx.planVersion.findFirst({ where: { plan: { key: FREE_PLAN_KEY } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    if (!version) {
      this.logger.warn("no Free plan version in the catalog; run the seed");
      return;
    }
    await tx.subscription.createMany({ data: [{ ownerType: owner.ownerType, ownerId: owner.ownerId, planVersionId: version.id, status: "ACTIVE", notifyUserId: notifyUserId ?? (owner.ownerType === "USER" ? owner.ownerId : null) }], skipDuplicates: true });
  }

  async ensureFreeFor(owner: Owner, notifyUserId?: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.ensureFree(tx, owner, notifyUserId));
    await this.entitlements.invalidate(owner);
  }

  // ── Customer actions ───────────────────────────────────────────────────────────────────────────────────────────────

  async checkout(owner: Owner, planVersionId: string, actorId: string): Promise<CheckoutResult> {
    const target = await this.purchasable(owner, planVersionId);
    const current = await this.currentPaid(owner);
    if (current) {
      if (current.planVersionId === target.id) throw new AppError("ALREADY_SUBSCRIBED", 409, "You are already on this plan");
      if (yearlyValue(target) <= yearlyValue(current.planVersion)) {
        throw new AppError("SUBSCRIPTION_EXISTS", 409, "You already have a paid subscription; change it instead of starting a new one");
      }
    }
    return this.startCheckout(owner, target, actorId);
  }

  async cancel(owner: Owner, subscriptionId: string): Promise<MySubscriptionView> {
    const row = await this.owned(owner, subscriptionId);
    if (!row.razorpaySubscriptionId) throw new AppError("SUBSCRIPTION_NOT_CANCELLABLE", 409, "The Free plan has nothing to cancel");
    if (!["ACTIVE", "TRIALING", "PAST_DUE"].includes(row.status)) {
      if (row.status === "CANCELLED") return this.me(owner);
      throw new AppError("SUBSCRIPTION_NOT_CANCELLABLE", 409, "This subscription is not active");
    }
    if (!row.cancelAtPeriodEnd) {
      await this.cancelAtCycleEnd(row.razorpaySubscriptionId);
      const done = await this.prisma.$transaction(async (tx) => {
        const r = await tx.subscription.updateMany({ where: { id: row.id, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] }, cancelAtPeriodEnd: false }, data: { cancelAtPeriodEnd: true, scheduledPlanVersionId: null } });
        if (r.count === 1) await this.emit(tx, row, "cancel_requested", row.status);
        return r.count === 1;
      });
      if (done) await this.entitlements.invalidate(owner);
    }
    return this.me(owner);
  }

  /** Upgrade: a new Razorpay subscription that takes over on its first charge. Downgrade: booked for the period end. */
  async change(owner: Owner, subscriptionId: string, planVersionId: string, actorId: string): Promise<ChangeResult> {
    const row = await this.owned(owner, subscriptionId);
    const target = await this.purchasable(owner, planVersionId);
    const currentVersion = await this.prisma.planVersion.findUniqueOrThrow({ where: { id: row.planVersionId } });
    if (!["ACTIVE", "TRIALING"].includes(row.status)) {
      throw new AppError(row.status === "PAST_DUE" ? "PAYMENT_PAST_DUE" : "SUBSCRIPTION_NOT_CHANGEABLE", 409, row.status === "PAST_DUE" ? "Fix the failed payment before changing plan" : "This subscription cannot be changed");
    }
    if (row.planVersionId === target.id) throw new AppError("SAME_PLAN", 409, "You are already on this plan");

    const upgrade = yearlyValue(target) > yearlyValue(currentVersion);
    if (upgrade || !row.razorpaySubscriptionId) {
      if (!upgrade) throw new AppError("SAME_PLAN", 409, "You are already on the Free plan");
      return { effective: "ON_PAYMENT", ...(await this.startCheckout(owner, target, actorId)) };
    }

    // Downgrade: stays on the current plan (and its price) until the period ends.
    if (row.scheduledPlanVersionId === target.id) return { effective: "AT_PERIOD_END", subscriptionId: row.id, scheduledPlanVersionId: target.id, effectiveAt: row.currentPeriodEnd?.toISOString() ?? null };
    const toFree = target.plan.key === FREE_PLAN_KEY;
    if (toFree) {
      await this.cancelAtCycleEnd(row.razorpaySubscriptionId);
    } else {
      const razorpayPlanId = await this.ensureRazorpayPlan(target);
      await this.razorpay.updateSubscription(row.razorpaySubscriptionId, { planId: razorpayPlanId, atCycleEnd: true });
    }
    const booked = await this.prisma.$transaction(async (tx) => {
      const r = await tx.subscription.updateMany({
        where: { id: row.id, status: { in: ["ACTIVE", "TRIALING"] } },
        data: { scheduledPlanVersionId: target.id, ...(toFree ? { cancelAtPeriodEnd: true } : {}) },
      });
      if (r.count === 1) await this.emit(tx, row, "downgrade_scheduled", row.status);
      return r.count === 1;
    });
    if (!booked) throw new AppError("SUBSCRIPTION_NOT_CHANGEABLE", 409, "This subscription changed while we were processing; try again");
    await this.entitlements.invalidate(owner);
    return { effective: "AT_PERIOD_END", subscriptionId: row.id, scheduledPlanVersionId: target.id, effectiveAt: row.currentPeriodEnd?.toISOString() ?? null };
  }

  /** Current plan, status, period end, limits and usage. Usage is reported by the modules that own the resources (UsageRegistry). */
  async me(owner: Owner): Promise<MySubscriptionView> {
    const plan = await this.entitlements.resolve(owner);
    const row = plan.subscriptionId ? await this.prisma.subscription.findUnique({ where: { id: plan.subscriptionId } }) : null;
    const usage: MySubscriptionView["usage"] = {};
    for (const [key, unit] of Object.entries(USAGE_UNIT) as [LimitKey, UsageView["unit"]][]) {
      const limit = plan.limits[key];
      const limitValue = typeof limit === "number" ? limit * (key === "storage_gb" ? 1024 ** 3 : 1) : null;
      usage[key] = { used: await this.usage.usage(owner, key), limit: limitValue, unit };
    }
    return {
      subscriptionId: plan.subscriptionId,
      plan: { key: plan.planKey, versionId: plan.versionId, commissionBps: plan.commissionBps },
      status: row?.status ?? "ACTIVE",
      currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
      graceEndsAt: row?.graceEndsAt?.toISOString() ?? null,
      scheduledPlanVersionId: row?.scheduledPlanVersionId ?? null,
      limits: plan.limits,
      usage,
    };
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** subscription.activated / subscription.charged. Idempotent: the ledger entry is keyed by the payment id, transitions are conditional. */
  async onCharged(event: WebhookEventContext): Promise<void> {
    const located = await this.locate(event);
    if (!located) return;
    const { row: seen, subscription, payment } = located;
    const periodEnd = unixToDate(subscription.current_end);
    const paymentId = typeof payment?.id === "string" ? payment.id : null;
    const amount = paymentId ? fromGatewayAmount(payment?.amount) : null;
    const gstBps = amount !== null ? await this.settings.get("gst_bps") : 0;

    let lateChargeOnto: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, seen.id);
      const row = await tx.subscription.findUniqueOrThrow({ where: { id: seen.id } });

      let postedNew = false;
      if (paymentId && amount !== null) {
        const { net, tax } = gstSplit(amount, gstBps);
        const [clearing, revenue, taxPayable] = [await this.accounts.platformAccount("GATEWAY_CLEARING", tx), await this.accounts.platformAccount("PLATFORM_REVENUE", tx), await this.accounts.platformAccount("TAX_PAYABLE", tx)];
        const posted = await this.ledger.post(tx, {
          refType: SUBSCRIPTION_CHARGE_REF,
          refId: paymentId,
          description: "Subscription charge",
          lines: [
            { accountId: clearing, amountPaise: -amount },
            { accountId: revenue, amountPaise: net },
            { accountId: taxPayable, amountPaise: tax },
          ],
        });
        postedNew = !posted.duplicate;
      }

      let change: SubChange | null = null;
      const advances = !!periodEnd && (!row.currentPeriodEnd || periodEnd > row.currentPeriodEnd);
      // Fresh = this event carries news (a payment we have not booked, or a later period). A replay or reordered event after a
      // failure must not bring a PAST_DUE/CANCELLED/EXPIRED subscription back; only INCOMPLETE and already-live rows move on any event.
      const fresh = postedNew || advances;
      // MON-2: a charge on a subscription that already ended (CANCELLED/EXPIRED) never revives it while the owner holds another live paid
      // subscription: reviving would expire the newer paid plan and cancel it at Razorpay, charging the owner twice for the plan they last
      // bought. The money is booked above; finance is alerted to refund it, and the newer subscription is left alone.
      if (fresh && (row.status === "CANCELLED" || row.status === "EXPIRED")) {
        const newer = await tx.subscription.findFirst({
          where: { ownerType: row.ownerType, ownerId: row.ownerId, id: { not: row.id }, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] }, razorpaySubscriptionId: { not: null } },
          select: { id: true },
        });
        if (newer) {
          lateChargeOnto = newer.id;
          return;
        }
      }
      const live = row.status === "ACTIVE" || row.status === "TRIALING";
      if (row.status === "INCOMPLETE" || live || fresh) {
        const newEnd = advances ? periodEnd : row.currentPeriodEnd;
        const newCycle = advances && !!row.currentPeriodEnd;
        const applyScheduled = newCycle && !!row.scheduledPlanVersionId && !row.cancelAtPeriodEnd;
        const reviving = row.status === "CANCELLED" || row.status === "EXPIRED";
        const moved = await tx.subscription.updateMany({
          where: { id: row.id, status: row.status },
          data: {
            status: "ACTIVE",
            graceEndsAt: null,
            currentPeriodEnd: newEnd,
            ...(reviving ? { cancelAtPeriodEnd: false } : {}),
            ...(applyScheduled ? { planVersionId: row.scheduledPlanVersionId!, scheduledPlanVersionId: null } : {}),
          },
        });
        if (moved.count === 1) {
          if (row.status === "INCOMPLETE" || reviving) {
            // This plan takes over: whatever the owner was on (Free, or a paid plan being upgraded from) ends now.
            await tx.subscription.updateMany({
              where: { ownerType: row.ownerType, ownerId: row.ownerId, id: { not: row.id }, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
              data: { status: "EXPIRED", graceEndsAt: null },
            });
            change = "activated";
          } else if (row.status === "PAST_DUE" || postedNew) {
            change = applyScheduled ? "plan_changed" : "renewed";
          }
        }
      }
      if (change) {
        const after = await tx.subscription.findUniqueOrThrow({ where: { id: row.id } });
        await this.emit(tx, after, change, after.status, paymentId ?? undefined);
      }
    });

    if (lateChargeOnto) {
      await this.alerts.raise({
        kind: "SUBSCRIPTION_LATE_CHARGE",
        message: `Razorpay charged ${paymentId ?? "a payment"} on the ended subscription ${seen.razorpaySubscriptionId}, but the owner (${seen.ownerType} ${seen.ownerId}) now holds the live subscription ${lateChargeOnto}. The old subscription was not revived. Refund the payment and make sure the old subscription is cancelled at Razorpay.`,
        dedupeKey: `subscription-late-charge:${paymentId ?? seen.id}`,
        data: { oldSubscriptionId: seen.id, liveSubscriptionId: lateChargeOnto, paymentId },
      });
      await this.entitlements.invalidate({ ownerType: seen.ownerType, ownerId: seen.ownerId });
      return;
    }
    await this.cancelSuperseded(seen);
    await this.entitlements.invalidate({ ownerType: seen.ownerType, ownerId: seen.ownerId });
  }

  /** subscription.halted / subscription.pending: the renewal failed. Access continues for the grace period. */
  async onPaymentFailed(event: WebhookEventContext): Promise<void> {
    const located = await this.locate(event);
    if (!located) return;
    const { row: seen } = located;
    const graceEndsAt = new Date(this.clock.now().getTime() + GRACE_PERIOD_MS);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, seen.id);
      const moved = await tx.subscription.updateMany({ where: { id: seen.id, status: { in: ["ACTIVE", "TRIALING"] } }, data: { status: "PAST_DUE", graceEndsAt } });
      if (moved.count === 1) await this.emit(tx, await tx.subscription.findUniqueOrThrow({ where: { id: seen.id } }), "payment_failed", "PAST_DUE");
    });
    await this.entitlements.invalidate({ ownerType: seen.ownerType, ownerId: seen.ownerId });
  }

  /** subscription.cancelled: access lasts to the period end the owner already paid for. */
  async onCancelled(event: WebhookEventContext): Promise<void> {
    const located = await this.locate(event);
    if (!located) return;
    const { row: seen } = located;
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, seen.id);
      const row = await tx.subscription.findUniqueOrThrow({ where: { id: seen.id } });
      if (row.status === "INCOMPLETE") {
        await tx.subscription.updateMany({ where: { id: row.id, status: "INCOMPLETE" }, data: { status: "EXPIRED" } });
        return;
      }
      if (!["ACTIVE", "TRIALING", "PAST_DUE"].includes(row.status)) return;
      if (row.currentPeriodEnd && row.currentPeriodEnd > now) {
        const moved = await tx.subscription.updateMany({ where: { id: row.id, status: row.status }, data: { status: "CANCELLED", cancelAtPeriodEnd: true, graceEndsAt: null, scheduledPlanVersionId: null } });
        if (moved.count === 1) await this.emit(tx, await tx.subscription.findUniqueOrThrow({ where: { id: row.id } }), "cancelled", "CANCELLED");
      } else {
        await this.expireInTx(tx, row, row.status, {});
      }
    });
    await this.entitlements.invalidate({ ownerType: seen.ownerType, ownerId: seen.ownerId });
  }

  /** subscription.completed: every billing cycle was paid and the subscription ended. */
  async onCompleted(event: WebhookEventContext): Promise<void> {
    const located = await this.locate(event);
    if (!located) return;
    const { row: seen } = located;
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, seen.id);
      const row = await tx.subscription.findUniqueOrThrow({ where: { id: seen.id } });
      if (["ACTIVE", "TRIALING", "PAST_DUE", "CANCELLED"].includes(row.status)) await this.expireInTx(tx, row, row.status, {});
    });
    await this.entitlements.invalidate({ ownerType: seen.ownerType, ownerId: seen.ownerId });
  }

  // ── Maintenance (every 15 minutes) ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Grace over -> EXPIRED (the owner is back on Free); cancelled and period-ended -> EXPIRED; booked downgrades whose period
   * ended are applied; abandoned checkouts are retired. Each step is a conditional update, so overlapping runs are harmless.
   */
  async runMaintenance(): Promise<{ expired: number; downgraded: number; abandoned: number; flagged: number }> {
    const now = this.clock.now();
    let expired = 0;
    let downgraded = 0;
    let abandoned = 0;

    const sweeps: Array<{ from: SubscriptionStatus; where: Prisma.SubscriptionWhereInput }> = [
      { from: "PAST_DUE", where: { graceEndsAt: { lte: now } } },
      { from: "CANCELLED", where: { OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lte: now } }] } },
      { from: "ACTIVE", where: { cancelAtPeriodEnd: true, currentPeriodEnd: { lte: now } } },
    ];
    for (const sweep of sweeps) {
      for (;;) {
        const rows = await this.prisma.subscription.findMany({ where: { status: sweep.from, ...sweep.where }, take: BATCH, orderBy: { id: "asc" } });
        let done = 0;
        for (const row of rows) {
          const ok = await this.prisma.$transaction(async (tx) => {
            await this.lock(tx, row.id);
            return this.expireInTx(tx, row, sweep.from, sweep.where);
          });
          if (ok) {
            done++;
            // MON-2: a lapsed (grace over) subscription must stop at Razorpay too, or its retry charges the owner after they moved on.
            if (sweep.from === "PAST_DUE" && row.razorpaySubscriptionId) {
              await this.razorpay.cancelSubscription(row.razorpaySubscriptionId, false).catch((err: unknown) => {
                if (err instanceof RazorpayApiError && err.status === 400) return; // already cancelled / completed
                this.logger.warn(`could not cancel lapsed subscription ${row.razorpaySubscriptionId} at Razorpay: ${(err as Error).message}`);
              });
            }
            await this.entitlements.invalidate({ ownerType: row.ownerType, ownerId: row.ownerId });
          }
        }
        expired += done;
        if (rows.length < BATCH || done === 0) break;
      }
    }

    const due = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE", cancelAtPeriodEnd: false, scheduledPlanVersionId: { not: null }, currentPeriodEnd: { lte: now } },
      take: BATCH,
      orderBy: { id: "asc" },
    });
    for (const row of due) {
      const ok = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, row.id);
        const moved = await tx.subscription.updateMany({
          where: { id: row.id, status: "ACTIVE", cancelAtPeriodEnd: false, scheduledPlanVersionId: row.scheduledPlanVersionId, currentPeriodEnd: { lte: now } },
          data: { planVersionId: row.scheduledPlanVersionId!, scheduledPlanVersionId: null },
        });
        if (moved.count === 1) await this.emit(tx, await tx.subscription.findUniqueOrThrow({ where: { id: row.id } }), "plan_changed", "ACTIVE");
        return moved.count === 1;
      });
      if (ok) {
        downgraded++;
        await this.entitlements.invalidate({ ownerType: row.ownerType, ownerId: row.ownerId });
      }
    }

    const stale = await this.prisma.subscription.findMany({ where: { status: "INCOMPLETE", createdAt: { lt: new Date(now.getTime() - ABANDONED_CHECKOUT_MS) } }, take: BATCH, orderBy: { id: "asc" } });
    for (const row of stale) {
      const r = await this.prisma.subscription.updateMany({ where: { id: row.id, status: "INCOMPLETE" }, data: { status: "EXPIRED", cancelAtPeriodEnd: true } });
      if (r.count === 1) {
        abandoned++;
        if (row.razorpaySubscriptionId) await this.razorpay.cancelSubscription(row.razorpaySubscriptionId, false).catch((err: unknown) => this.logger.warn(`could not cancel abandoned checkout ${row.razorpaySubscriptionId}: ${(err as Error).message}`));
      }
    }
    return { expired, downgraded, abandoned, flagged: await this.flagMissedRenewals(now) };
  }

  /**
   * MON-10: an ACTIVE paid subscription entitles without an end, so a lost renewal / halted webhook would keep the plan (and its lower
   * commission) forever. One whose paid period ended more than MISSED_RENEWAL_AFTER_MS ago without a renewal is NOT expired here (the
   * webhook may only be late, and cutting a paying customer is worse): finance is alerted, once per row and period, to check it at Razorpay.
   */
  private async flagMissedRenewals(now: Date): Promise<number> {
    const rows = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE", cancelAtPeriodEnd: false, razorpaySubscriptionId: { not: null }, currentPeriodEnd: { lt: new Date(now.getTime() - MISSED_RENEWAL_AFTER_MS) } },
      take: BATCH,
      orderBy: { id: "asc" },
    });
    for (const row of rows) {
      await this.alerts.raise({
        kind: "SUBSCRIPTION_LAPSED",
        message: `Subscription ${row.id} (${row.ownerType} ${row.ownerId}, Razorpay ${row.razorpaySubscriptionId}) is ACTIVE but its paid period ended ${row.currentPeriodEnd?.toISOString()} with no renewal. A webhook was probably lost: check it at Razorpay, then cancel or renew it.`,
        dedupeKey: `subscription-lapsed:${row.id}:${row.currentPeriodEnd?.getTime()}`,
        data: { subscriptionId: row.id, razorpaySubscriptionId: row.razorpaySubscriptionId },
        link: "/admin/subscriptions",
      });
    }
    return rows.length;
  }

  // ── Outbox consumer ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Busts the entitlements cache (again: the writer already did) and tells the owner about activation, a failed payment or expiry. */
  async onChanged(e: Extract<DomainEvent, { type: "subscription.changed" }>, eventId: string): Promise<void> {
    await this.entitlements.invalidate({ ownerType: e.ownerType, ownerId: e.ownerId });
    const text = {
      activated: { type: "subscription.activated", title: "Your plan is active", body: `Your ${e.planKey} plan is now active.` },
      payment_failed: { type: "subscription.payment_failed", title: "We could not charge your payment method", body: `Your ${e.planKey} plan stays active for 3 more days. Update your payment method to keep it.` },
      expired: { type: "subscription.expired", title: "Your plan has ended", body: "Your paid plan ended and your account is back on the Free plan." },
    } as const;
    const note = (text as Record<string, { type: "subscription.activated" | "subscription.payment_failed" | "subscription.expired"; title: string; body: string }>)[e.change];
    if (!note) return;
    const userId = e.notifyUserId ?? (e.ownerType === "USER" ? e.ownerId : null);
    if (!userId) return;
    await this.notifications.notify(userId, { type: note.type, title: note.title, body: note.body, data: { subscriptionId: e.subscriptionId, planKey: e.planKey, ownerType: e.ownerType, ownerId: e.ownerId }, sourceEventId: eventId });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Conditional EXPIRED transition; the owner falls back to Free (a Free row is ensured). Returns whether this call moved the row. */
  private async expireInTx(tx: Prisma.TransactionClient, row: Subscription, from: SubscriptionStatus, extra: Prisma.SubscriptionWhereInput): Promise<boolean> {
    const moved = await tx.subscription.updateMany({ where: { id: row.id, status: from, ...extra }, data: { status: "EXPIRED", graceEndsAt: null, scheduledPlanVersionId: null } });
    if (moved.count !== 1) return false;
    await this.ensureFree(tx, { ownerType: row.ownerType, ownerId: row.ownerId }, row.notifyUserId);
    await this.emit(tx, await tx.subscription.findUniqueOrThrow({ where: { id: row.id } }), "expired", "EXPIRED");
    return true;
  }

  private async emit(tx: Prisma.TransactionClient, row: Subscription, change: SubChange, status: string, paymentId?: string): Promise<void> {
    const version = await tx.planVersion.findUniqueOrThrow({ where: { id: row.planVersionId }, include: { plan: { select: { key: true } } } });
    const notifyUserId = row.notifyUserId ?? (row.ownerType === "USER" ? row.ownerId : null);
    await this.outbox.enqueue(tx, {
      type: "subscription.changed",
      subscriptionId: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      planKey: version.plan.key,
      planVersionId: row.planVersionId,
      status,
      change,
      ...(paymentId ? { paymentId } : {}),
      ...(notifyUserId ? { notifyUserId } : {}),
    });
  }

  private async lock(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${id} FOR UPDATE`;
  }

  /** The subscription row a webhook is about. An unknown id is acknowledged (logged), never retried forever. */
  private async locate(event: WebhookEventContext) {
    const subscription = entityOf(event.payload, "subscription");
    const payment = entityOf(event.payload, "payment");
    const razorpayId = typeof subscription?.id === "string" ? subscription.id : null;
    if (!subscription || !razorpayId) {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) has no subscription entity; ignored`);
      return null;
    }
    const row = await this.prisma.subscription.findUnique({ where: { razorpaySubscriptionId: razorpayId } });
    if (!row) {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) is for unknown subscription ${razorpayId}; marked processed`);
      return null;
    }
    return { row, subscription, payment };
  }

  /** After an upgrade the old paid subscription stops renewing at the end of the cycle it already paid for. Retried by redelivery until it sticks. */
  private async cancelSuperseded(active: Subscription): Promise<void> {
    const old = await this.prisma.subscription.findMany({
      where: { ownerType: active.ownerType, ownerId: active.ownerId, id: { not: active.id }, status: "EXPIRED", razorpaySubscriptionId: { not: null }, cancelAtPeriodEnd: false },
    });
    for (const o of old) {
      await this.cancelAtCycleEnd(o.razorpaySubscriptionId!);
      await this.prisma.subscription.updateMany({ where: { id: o.id }, data: { cancelAtPeriodEnd: true } });
    }
  }

  /** Razorpay answers 400 when the subscription is already cancelled/completed or not yet started: that is the state we want. */
  private async cancelAtCycleEnd(razorpaySubscriptionId: string): Promise<void> {
    try {
      await this.razorpay.cancelSubscription(razorpaySubscriptionId, true);
    } catch (err) {
      if (err instanceof RazorpayApiError && err.status === 400) {
        this.logger.warn(`razorpay refused to cancel ${razorpaySubscriptionId} at cycle end (${err.message}); treating as already ended`);
        return;
      }
      throw err;
    }
  }

  private async owned(owner: Owner, id: string): Promise<Subscription> {
    const row = await this.prisma.subscription.findFirst({ where: { id, ownerType: owner.ownerType, ownerId: owner.ownerId } });
    if (!row) throw new AppError("SUBSCRIPTION_NOT_FOUND", 404, "Subscription not found");
    return row;
  }

  /** The owner's entitled paid subscription (not the Free fallback), if any. */
  private async currentPaid(owner: Owner) {
    const plan = await this.entitlements.resolve(owner);
    if (!plan.subscriptionId) return null;
    const row = await this.prisma.subscription.findUnique({ where: { id: plan.subscriptionId }, include: { planVersion: true } });
    return row?.razorpaySubscriptionId ? row : null;
  }

  /** A paid version of an active plan for this kind of owner, and the newest one of its interval (older versions only serve existing subscribers). */
  private async purchasable(owner: Owner, planVersionId: string): Promise<VersionWithPlan> {
    const version = await this.prisma.planVersion.findUnique({ where: { id: planVersionId }, include: { plan: true } });
    if (!version || !version.plan.isActive) throw new AppError("PLAN_NOT_FOUND", 404, "Plan not found");
    const audience = owner.ownerType === "USER" ? "CREATOR" : "ORG";
    if (version.plan.key !== FREE_PLAN_KEY && version.plan.audience !== audience) {
      throw new AppError("PLAN_AUDIENCE_MISMATCH", 422, owner.ownerType === "USER" ? "This plan is for organizations" : "This plan is for creators");
    }
    const newest = await this.prisma.planVersion.findFirst({ where: { planId: version.planId, interval: version.interval }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    if (newest?.id !== version.id) throw new AppError("PLAN_VERSION_SUPERSEDED", 409, "This plan version is no longer offered; fetch the current plans");
    return version;
  }

  /**
   * Serialised per owner (advisory lock held for the Razorpay call, a few hundred ms): a double click, or two tabs, get the same
   * INCOMPLETE subscription back instead of two payable Razorpay subscriptions.
   */
  private async startCheckout(owner: Owner, target: VersionWithPlan, actorId: string): Promise<CheckoutResult> {
    if (target.pricePaise <= 0n) throw new AppError("PLAN_NOT_PURCHASABLE", 422, "This plan is free; there is nothing to pay for");
    const keyId = this.config.razorpay.keyId;
    // Before the transaction: it opens a transaction of its own, which would be a second pooled connection while this one holds the first.
    const razorpayPlanId = await this.ensureRazorpayPlan(target);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub-checkout:${owner.ownerType}:${owner.ownerId}`}))`;
        const reusable = await tx.subscription.findFirst({
          where: { ownerType: owner.ownerType, ownerId: owner.ownerId, planVersionId: target.id, status: "INCOMPLETE", razorpaySubscriptionId: { not: null }, createdAt: { gt: new Date(this.clock.now().getTime() - REUSE_CHECKOUT_MS) } },
          orderBy: { createdAt: "desc" },
        });
        if (reusable) return { subscriptionId: reusable.id, razorpaySubscriptionId: reusable.razorpaySubscriptionId!, keyId };

        const id = uuidv7();
        const created = await this.razorpay.createSubscription({
          planId: razorpayPlanId,
          totalCount: target.interval === "YEAR" ? 10 : 120,
          notes: { subscriptionId: id, ownerType: owner.ownerType, ownerId: owner.ownerId, planVersionId: target.id },
        });
        await tx.subscription.create({
          data: { id, ownerType: owner.ownerType, ownerId: owner.ownerId, planVersionId: target.id, status: "INCOMPLETE", razorpaySubscriptionId: created.id, notifyUserId: actorId },
        });
        return { subscriptionId: id, razorpaySubscriptionId: created.id, keyId };
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  }

  /**
   * Created on the first checkout of a paid version and cached on the row. Razorpay has no idempotency key for plans, so the
   * read-create-store runs under a per-version advisory lock (held for one HTTP call): concurrent first checkouts create one plan.
   * The conditional store is a backstop; if it ever loses, the stored plan wins and the orphan is logged.
   */
  private async ensureRazorpayPlan(version: VersionWithPlan): Promise<string> {
    if (version.razorpayPlanId) return version.razorpayPlanId;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rzp-plan:${version.id}`}))`;
        const stored = await tx.planVersion.findUniqueOrThrow({ where: { id: version.id }, select: { razorpayPlanId: true } });
        if (stored.razorpayPlanId) return stored.razorpayPlanId;
        const created = await this.razorpay.createPlan({
          period: version.interval === "YEAR" ? "yearly" : "monthly",
          interval: 1,
          name: `${version.plan.name} (${version.interval === "YEAR" ? "yearly" : "monthly"})`,
          amountPaise: version.pricePaise,
          notes: { planVersionId: version.id, planKey: version.plan.key },
        });
        const claimed = await tx.planVersion.updateMany({ where: { id: version.id, razorpayPlanId: null }, data: { razorpayPlanId: created.id } });
        if (claimed.count === 1) return created.id;
        const winner = await tx.planVersion.findUniqueOrThrow({ where: { id: version.id }, select: { razorpayPlanId: true } });
        this.logger.warn(`razorpay plan ${created.id} for version ${version.id} is an orphan; ${winner.razorpayPlanId} was stored first`);
        return winner.razorpayPlanId ?? created.id;
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  }
}
