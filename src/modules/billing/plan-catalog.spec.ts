import { gigLimitFor, planLimitsSchema, SEED_PLANS, withLimitDefaults } from "./plan-catalog";

const OLD = { max_published_courses: 3, storage_gb: 5, reels_per_day: 3, analytics_level: "basic", creator_coupons: false, org_seats: 0 };

describe("max_active_gigs in the plan catalog", () => {
  it("seeds Free 5, Pro 25, Business and the organization plans unlimited", () => {
    const limit = (key: string) => SEED_PLANS.find((p) => p.key === key)?.versions.map((v) => v.limits.max_active_gigs);
    expect(limit("free")).toEqual([5]);
    expect(limit("pro")).toEqual([25, 25]);
    expect(limit("business")).toEqual([null, null]);
    expect(limit("org_starter")).toEqual([null, null]);
    expect(limit("org_growth")).toEqual([null, null]);
  });

  it("a stored version without the key reads with its plan key's default; a stored value wins, null included", () => {
    expect(withLimitDefaults("free", OLD).max_active_gigs).toBe(5);
    expect(withLimitDefaults("pro", OLD).max_active_gigs).toBe(25);
    expect(withLimitDefaults("business", OLD).max_active_gigs).toBeNull();
    expect(withLimitDefaults("org_growth", OLD).max_active_gigs).toBeNull();
    expect(withLimitDefaults("some_new_plan", OLD).max_active_gigs).toBe(5);
    expect(withLimitDefaults("pro", { ...OLD, max_active_gigs: 3 }).max_active_gigs).toBe(3);
    expect(withLimitDefaults("pro", { ...OLD, max_active_gigs: null }).max_active_gigs).toBeNull();
    expect(withLimitDefaults("pro", OLD)).toMatchObject(OLD);
    // plan keys are data: a key that names an Object.prototype member must not be mistaken for a configured plan
    expect(gigLimitFor("constructor")).toBe(5);
    expect(gigLimitFor("toString")).toBe(5);
  });

  it("the admin schema accepts a version with or without the key, and refuses negatives and unknown keys", () => {
    expect(planLimitsSchema.safeParse(OLD).success).toBe(true);
    expect(planLimitsSchema.safeParse({ ...OLD, max_active_gigs: null }).success).toBe(true);
    expect(planLimitsSchema.safeParse({ ...OLD, max_active_gigs: 10 }).success).toBe(true);
    expect(planLimitsSchema.safeParse({ ...OLD, max_active_gigs: -1 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...OLD, max_active_gigs: 1.5 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...OLD, extra: 1 }).success).toBe(false);
  });
});
