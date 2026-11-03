import { z } from "zod";

/** Entitlement keys stored in `plan_versions.limits`. `null` means unlimited. */
export const LIMIT_KEYS = ["max_published_courses", "storage_gb", "reels_per_day", "analytics_level", "creator_coupons", "org_seats"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const ANALYTICS_LEVELS = ["basic", "standard", "advanced"] as const;

export interface PlanLimits {
  max_published_courses: number | null;
  storage_gb: number | null;
  reels_per_day: number | null;
  analytics_level: (typeof ANALYTICS_LEVELS)[number];
  creator_coupons: boolean;
  org_seats: number | null;
}

const count = z.number().int().min(0).max(1_000_000_000).nullable();

/** Every key is required, unknown keys are rejected: a plan version is a complete, immutable statement of what a plan grants. */
export const planLimitsSchema = z
  .object({
    max_published_courses: count,
    storage_gb: count,
    reels_per_day: count,
    analytics_level: z.enum(ANALYTICS_LEVELS),
    creator_coupons: z.boolean(),
    org_seats: count,
  })
  .strict();

export const FREE_PLAN_KEY = "free";

export interface SeedVersion {
  pricePaise: bigint;
  interval: "MONTH" | "YEAR";
  commissionBps: number;
  limits: PlanLimits;
}

export interface SeedPlan {
  key: string;
  name: string;
  audience: "CREATOR" | "ORG";
  versions: SeedVersion[];
}

const lim = (
  max_published_courses: number | null,
  storage_gb: number | null,
  reels_per_day: number | null,
  analytics_level: PlanLimits["analytics_level"],
  creator_coupons: boolean,
  org_seats: number | null,
): PlanLimits => ({ max_published_courses, storage_gb, reels_per_day, analytics_level, creator_coupons, org_seats });

const RUPEE = 100n;
/** Paid plans: monthly price, yearly = 10 x monthly (plan decision 3). */
const paid = (monthlyRupees: bigint, commissionBps: number, limits: PlanLimits): SeedVersion[] => [
  { pricePaise: monthlyRupees * RUPEE, interval: "MONTH", commissionBps, limits },
  { pricePaise: monthlyRupees * 10n * RUPEE, interval: "YEAR", commissionBps, limits },
];

const FREE_LIMITS = lim(3, 5, 3, "basic", false, 0);
export const FREE_COMMISSION_BPS = 1000;

/** Plan decision 3. Admin-editable afterwards (new versions); the seed only fills in what is missing. */
export const SEED_PLANS: readonly SeedPlan[] = [
  { key: FREE_PLAN_KEY, name: "Free", audience: "CREATOR", versions: [{ pricePaise: 0n, interval: "MONTH", commissionBps: FREE_COMMISSION_BPS, limits: FREE_LIMITS }] },
  { key: "pro", name: "Pro", audience: "CREATOR", versions: paid(999n, 700, lim(50, 100, 20, "standard", true, 0)) },
  { key: "business", name: "Business", audience: "CREATOR", versions: paid(2999n, 500, lim(null, 500, 50, "advanced", true, 0)) },
  { key: "org_starter", name: "Org Starter", audience: "ORG", versions: paid(4999n, 700, lim(null, 500, 50, "standard", true, 10)) },
  { key: "org_growth", name: "Org Growth", audience: "ORG", versions: paid(14999n, 500, lim(null, 2000, 100, "advanced", true, 50)) },
];

/** What an owner without any entitled subscription gets if the catalog has no Free plan row (an unseeded database). */
export const FREE_FALLBACK = { planKey: FREE_PLAN_KEY, versionId: "free-default", commissionBps: FREE_COMMISSION_BPS, limits: FREE_LIMITS } as const;
