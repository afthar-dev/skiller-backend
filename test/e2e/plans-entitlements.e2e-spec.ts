import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EntitlementsService } from "../../src/modules/billing";
import { CreatorService } from "../../src/modules/users";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uid = () => randomUUID().replace(/-/g, "").slice(0, 10);
const MB = 1024 * 1024;
const LIMITS = { max_published_courses: 1, storage_gb: 1, reels_per_day: 1, analytics_level: "basic", creator_coupons: false, org_seats: 0 };

describe("plans and entitlements", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let ent: EntitlementsService;
  let admin: Session;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function stepUp(s: Session) {
    const before = t.mail.sent.filter((m) => m.to === s.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(s)).set("X-Forwarded-For", uniqueIp());
    const code = await t.codeFor(s.email, before);
    await http().post("/v1/auth/step-up/verify").set(auth(s)).send({ challengeId: res.body.challengeId, code }).expect(204);
  }
  async function staffWith(permissionKeys: string[], withStepUp = true) {
    const key = `staff_${uid()}`;
    await http().post("/v1/admin/roles").set(auth(admin)).send({ key, name: key, scope: "PLATFORM", permissionKeys }).expect(201);
    const s = await t.login();
    await http().post(`/v1/admin/users/${s.userId}/roles`).set(auth(admin)).send({ roleKey: key }).expect(201);
    if (withStepUp) await stepUp(s);
    return s;
  }
  const creator = async () => {
    const s = await t.login();
    await t.app.get(CreatorService).becomeCreator(s.userId);
    return s;
  };

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    ent = t.app.get(EntitlementsService);
    admin = await t.login("admin@skiller.test");
    await stepUp(admin);
  });
  afterAll(() => t?.close());

  it("seeds the catalog exactly (plans, versions, limits)", async () => {
    const res = await http().get("/v1/plans");
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.items.map((p: { key: string }) => [p.key, p]));
    expect(Object.keys(byKey)).toEqual(expect.arrayContaining(["free", "pro", "business", "org_starter", "org_growth"]));
    const pro = byKey.pro.versions.find((v: { interval: string }) => v.interval === "MONTH");
    expect(pro).toMatchObject({ pricePaise: "99900", commissionBps: 700, limits: { max_published_courses: 50, storage_gb: 100, reels_per_day: 20, analytics_level: "standard", creator_coupons: true, org_seats: 0 } });
    expect(byKey.pro.versions.find((v: { interval: string }) => v.interval === "YEAR").pricePaise).toBe("999000");
    expect(byKey.business.versions[0].limits.max_published_courses).toBeNull();
    expect(byKey.org_starter.versions[0].limits.org_seats).toBe(10);
    expect(byKey.org_growth.audience).toBe("ORG");
  });

  it("an owner without a subscription is on Free at 1000 bps", async () => {
    const plan = await ent.planFor("USER", randomUUID());
    expect(plan).toMatchObject({ planKey: "free", commissionBps: 1000, limits: { max_published_courses: 3, storage_gb: 5, reels_per_day: 3, analytics_level: "basic", creator_coupons: false, org_seats: 0 } });
    await expect(ent.check({ ownerType: "USER", ownerId: randomUUID() }, "creator_coupons", 0)).rejects.toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED", status: 403, details: { key: "creator_coupons", limit: false } });
  });

  it("a new plan version does not change an existing subscriber commission; new buyers get it", async () => {
    const me = await creator();
    await givePlan(prisma, "USER", me.userId, "pro");
    expect((await ent.planFor("USER", me.userId)).commissionBps).toBe(700);

    const pro = await prisma.plan.findUniqueOrThrow({ where: { key: "pro" }, include: { versions: { where: { interval: "MONTH" }, orderBy: { createdAt: "asc" } } } });
    const original = pro.versions[0];
    const staff = await staffWith(["billing.plans.manage"]);
    const res = await http()
      .post(`/v1/admin/plans/${pro.id}/versions`)
      .set(auth(staff))
      .send({ pricePaise: "129900", interval: "MONTH", commissionBps: 600, limits: original.limits });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pricePaise: "129900", commissionBps: 600 });
    await ent.invalidate({ ownerType: "USER", ownerId: me.userId });
    expect((await ent.planFor("USER", me.userId)).commissionBps).toBe(700);
    const stored = await prisma.planVersion.findUniqueOrThrow({ where: { id: original.id } });
    expect(stored.pricePaise).toBe(99900n);
    expect(await prisma.auditLog.count({ where: { action: "plan.version_create", targetId: res.body.id } })).toBe(1);
    const pub = (await http().get("/v1/plans")).body.items.find((p: { key: string }) => p.key === "pro");
    expect(pub.versions.filter((v: { interval: string }) => v.interval === "MONTH")).toHaveLength(1);
  });

  it("admin plan routes need billing.plans.manage and (for writes) a step-up", async () => {
    const plain = await t.login();
    expect((await http().get("/v1/admin/plans").set(auth(plain))).status).toBe(403);
    const noStep = await staffWith(["billing.plans.manage"], false);
    expect((await http().get("/v1/admin/plans").set(auth(noStep))).status).toBe(200);
    const body = { key: `p_${uid()}`, name: "X", audience: "CREATOR", version: { pricePaise: "5000", interval: "MONTH", commissionBps: 800, limits: LIMITS } };
    expect((await http().post("/v1/admin/plans").set(auth(noStep)).send(body)).body.error.code).toBe("STEP_UP_REQUIRED");
    const ok = await staffWith(["billing.plans.manage"]);
    expect((await http().post("/v1/admin/plans").set(auth(ok)).send(body)).status).toBe(201);
    expect((await http().post("/v1/admin/plans").set(auth(ok)).send(body)).body.error.code).toBe("PLAN_KEY_TAKEN");
    const bad = await http().post("/v1/admin/plans").set(auth(ok)).send({ ...body, key: `p_${uid()}`, version: { ...body.version, limits: { storage_gb: 1 } } });
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("a plan version written without max_active_gigs is stored and read back with its plan key's default (a throwaway plan: the real catalog is shared by every suite)", async () => {
    const staff = await staffWith(["billing.plans.manage"]);
    const created = await http().post("/v1/admin/plans").set(auth(staff)).send({ key: `p_${uid()}`, name: "X", audience: "CREATOR", version: { pricePaise: "5000", interval: "MONTH", commissionBps: 800, limits: LIMITS } });
    expect(created.status).toBe(201);
    expect(created.body.versions[0].limits.max_active_gigs).toBe(5); // an unknown plan key gets the Free value
    expect((await prisma.planVersion.findUniqueOrThrow({ where: { id: created.body.versions[0].id } })).limits).toMatchObject({ max_active_gigs: 5 });
    const next = await http().post(`/v1/admin/plans/${created.body.id}/versions`).set(auth(staff)).send({ pricePaise: "6000", interval: "MONTH", commissionBps: 700, limits: LIMITS });
    expect(next.body.limits.max_active_gigs).toBe(5);
    const explicit = await http().post(`/v1/admin/plans/${created.body.id}/versions`).set(auth(staff)).send({ pricePaise: "7000", interval: "MONTH", commissionBps: 700, limits: { ...LIMITS, max_active_gigs: null } });
    expect(explicit.body.limits.max_active_gigs).toBeNull();
    const negative = await http().post(`/v1/admin/plans/${created.body.id}/versions`).set(auth(staff)).send({ pricePaise: "8000", interval: "MONTH", commissionBps: 700, limits: { ...LIMITS, max_active_gigs: -1 } });
    expect(negative.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("an upload past the plan storage_gb is refused with ENTITLEMENT_LIMIT_REACHED", async () => {
    const me = await creator();
    const plan = await prisma.plan.create({ data: { key: `tiny_${uid()}`, name: "Tiny", audience: "CREATOR" } });
    const v = await prisma.planVersion.create({ data: { planId: plan.id, pricePaise: 100n, interval: "MONTH", commissionBps: 900, limits: LIMITS } });
    await prisma.subscription.create({ data: { ownerType: "USER", ownerId: me.userId, planVersionId: v.id, status: "ACTIVE", razorpaySubscriptionId: `sub_${uid()}` } });
    const create = (size: number) => http().post("/v1/media/uploads").set(auth(me)).send({ purpose: "course_lesson", filename: "a.mp4", mime: "video/mp4", size });
    expect((await create(600 * MB)).status).toBe(201);
    const second = await create(600 * MB);
    expect(second.status).toBe(403);
    expect(second.body.error).toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED", details: { key: "storage_gb", limit: 1 } });
    expect((await create(400 * MB)).status).toBe(201);
  });

  it("org invites are limited by org_seats (owner and pending invites count); Free orgs have no seats", async () => {
    const owner = await t.login();
    const org = (await http().post("/v1/orgs").set(auth(owner)).send({ name: "Seats Inc", slug: `seats-${uid()}` })).body as { id: string; slug: string };
    const invite = (email: string) => http().post(`/v1/orgs/${org.slug}/invites`).set(auth(owner)).send({ email, roleKey: "org_learner" });
    const free = await invite(`a-${uid()}@example.com`);
    expect(free.status).toBe(403);
    expect(free.body.error).toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED", details: { key: "org_seats", limit: 0 } });

    await givePlan(prisma, "ORG", org.id, "org_starter");
    await ent.invalidate({ ownerType: "ORG", ownerId: org.id });
    const same = `same-${uid()}@example.com`;
    expect((await invite(same)).status).toBe(201);
    expect((await invite(same)).status).toBe(201); // re-inviting an address replaces its invite: still one seat
    for (let i = 0; i < 9; i++) expect((await invite(`m${i}-${uid()}@example.com`)).status).toBe(201); // 10 invitable seats; the owner is not one
    const over = await invite(`over-${uid()}@example.com`);
    expect(over.status).toBe(403);
    expect(over.body.error).toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED", details: { key: "org_seats", limit: 10 } });
  });

  it("the plan is cached and busted on invalidate", async () => {
    const me = await creator();
    expect((await ent.planFor("USER", me.userId)).planKey).toBe("free");
    await givePlan(prisma, "USER", me.userId, "business");
    expect((await ent.planFor("USER", me.userId)).planKey).toBe("free");
    await ent.invalidate({ ownerType: "USER", ownerId: me.userId });
    expect((await ent.planFor("USER", me.userId)).planKey).toBe("business");
  });
});
