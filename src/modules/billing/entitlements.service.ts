import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";
import { FREE_FALLBACK, FREE_PLAN_KEY, type LimitKey, type PlanLimits } from "./plan-catalog";

export type OwnerType = "USER" | "ORG";
export interface Owner {
  ownerType: OwnerType;
  ownerId: string;
}

export interface PlanSnapshot {
  planKey: string;
  versionId: string;
  commissionBps: number;
  limits: PlanLimits;
}

/** The snapshot plus where it came from; this is what is cached. `subscriptionId` is null for the Free fallback. */
export interface ResolvedPlan extends PlanSnapshot {
  subscriptionId: string | null;
  status: string | null;
}

export const ENTITLEMENTS_CACHE_TTL_SEC = 60;
// Entries live under ent:{ownerType}:{ownerId}:{epoch}. Invalidation bumps the epoch, so a reader that loaded the DB before a
// subscription change and writes after it lands on an old-epoch key nobody reads again. Epoch keys have no TTL on purpose
// (same reasoning as the permission cache): a lapsed epoch would restart and a later bump could hit a live entry.
const epochKey = (o: Owner) => `ent:epoch:${o.ownerType}:${o.ownerId}`;
const cacheKey = (o: Owner, epoch: number) => `ent:${o.ownerType}:${o.ownerId}:${epoch}`;

const ENTITLED_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE", "CANCELLED"] as const;

/** Usage passed to check() is in the unit the caller measures; limits whose name carries a unit are converted to it. */
const LIMIT_UNIT: Partial<Record<LimitKey, number>> = { storage_gb: 1024 ** 3 };

/**
 * Plan, limits and commission of an owner. `subscriptions` is the only source: no entitled subscription means the Free plan.
 * Entitled = ACTIVE (unless cancelled and past its period end), TRIALING, PAST_DUE inside its grace window, CANCELLED until
 * the period end it already paid for.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async planFor(ownerType: OwnerType, ownerId: string): Promise<PlanSnapshot> {
    const { planKey, versionId, commissionBps, limits } = await this.resolve({ ownerType, ownerId });
    return { planKey, versionId, commissionBps, limits };
  }

  /** Same as planFor plus the subscription the plan comes from (for "my subscription" views). */
  async resolve(owner: Owner): Promise<ResolvedPlan> {
    // Epoch first, then the DB: a change committed after this read bumps the epoch past it.
    const epoch = Number(await this.redis.get(epochKey(owner))) || 0;
    const key = cacheKey(owner, epoch);
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as ResolvedPlan;
      } catch {
        // corrupt entry: rebuild
      }
    }
    const { plan, validUntil } = await this.load(owner);
    // A cached answer must not outlive the instant it stops being true (grace end, period end).
    let ttl = ENTITLEMENTS_CACHE_TTL_SEC;
    if (validUntil !== null) ttl = Math.max(1, Math.min(ttl, Math.floor((validUntil.getTime() - this.clock.now().getTime()) / 1000)));
    await this.redis.set(key, JSON.stringify(plan), "EX", ttl).catch(() => undefined);
    return plan;
  }

  async limit<K extends LimitKey>(owner: Owner, key: K): Promise<PlanLimits[K]> {
    return (await this.planFor(owner.ownerType, owner.ownerId)).limits[key];
  }

  /**
   * Throws ENTITLEMENT_LIMIT_REACHED (403, details { key, limit }) when `usageAfter` (what the usage would be once the action
   * succeeds, in the caller's unit: bytes for storage_gb, counts otherwise) exceeds the limit. `null` = unlimited. A boolean
   * limit that is false always refuses. Text limits (analytics_level) are read with limit(), not checked.
   */
  async check(owner: Owner, key: LimitKey, usageAfter: number): Promise<void> {
    const limit = await this.limit(owner, key);
    if (limit === null) return;
    if (typeof limit === "boolean") {
      if (!limit) throw this.reached(key, limit);
      return;
    }
    if (typeof limit === "number" && usageAfter > limit * (LIMIT_UNIT[key] ?? 1)) throw this.reached(key, limit);
  }

  /** Call after every subscription change (the write has committed). Extra bumps are harmless: one cache miss. */
  async invalidate(owner: Owner): Promise<void> {
    await this.redis.incr(epochKey(owner));
  }

  private reached(key: LimitKey, limit: number | boolean) {
    return new AppError("ENTITLEMENT_LIMIT_REACHED", 403, "Your plan's limit has been reached; upgrade to continue", { key, limit });
  }

  private async load(owner: Owner): Promise<{ plan: ResolvedPlan; validUntil: Date | null }> {
    const now = this.clock.now();
    const subs = await this.prisma.subscription.findMany({
      where: { ownerType: owner.ownerType, ownerId: owner.ownerId, status: { in: [...ENTITLED_STATUSES] } },
      include: { planVersion: { include: { plan: true } } },
    });
    let best: { sub: (typeof subs)[number]; until: Date | null } | null = null;
    for (const sub of subs) {
      const until = this.entitledUntil(sub, now);
      if (until === undefined) continue;
      // Highest price wins if (briefly) two rows are entitled; newest breaks ties.
      if (!best || sub.planVersion.pricePaise > best.sub.planVersion.pricePaise || (sub.planVersion.pricePaise === best.sub.planVersion.pricePaise && sub.createdAt > best.sub.createdAt)) best = { sub, until };
    }
    if (best) {
      const v = best.sub.planVersion;
      return {
        plan: { planKey: v.plan.key, versionId: v.id, commissionBps: v.commissionBps, limits: v.limits as unknown as PlanLimits, subscriptionId: best.sub.id, status: best.sub.status },
        validUntil: best.until,
      };
    }
    return { plan: await this.freePlan(), validUntil: null };
  }

  /** undefined = not entitled now; null = entitled with no end in sight; Date = entitled until then. */
  private entitledUntil(s: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null; graceEndsAt: Date | null; trialEndsAt: Date | null }, now: Date): Date | null | undefined {
    const t = now.getTime();
    switch (s.status) {
      case "ACTIVE":
        if (s.cancelAtPeriodEnd && s.currentPeriodEnd) return s.currentPeriodEnd.getTime() > t ? s.currentPeriodEnd : undefined;
        return null;
      case "TRIALING":
        if (!s.trialEndsAt) return null;
        return s.trialEndsAt.getTime() > t ? s.trialEndsAt : undefined;
      case "PAST_DUE":
        return s.graceEndsAt && s.graceEndsAt.getTime() > t ? s.graceEndsAt : undefined;
      case "CANCELLED":
        return s.currentPeriodEnd && s.currentPeriodEnd.getTime() > t ? s.currentPeriodEnd : undefined;
      default:
        return undefined;
    }
  }

  private async freePlan(): Promise<ResolvedPlan> {
    const version = await this.prisma.planVersion.findFirst({ where: { plan: { key: FREE_PLAN_KEY } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { plan: true } });
    if (!version) return { ...FREE_FALLBACK, subscriptionId: null, status: null };
    return { planKey: version.plan.key, versionId: version.id, commissionBps: version.commissionBps, limits: version.limits as unknown as PlanLimits, subscriptionId: null, status: null };
  }
}
