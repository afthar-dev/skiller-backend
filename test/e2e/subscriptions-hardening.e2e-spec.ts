import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EntitlementsService, FakeRazorpayClient, RAZORPAY_CLIENT, SubscriptionsService } from "../../src/modules/billing";
import { CreatorService } from "../../src/modules/users";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uid = () => randomUUID().replace(/-/g, "").slice(0, 10);
const DAY = 86400_000;
const LIMITS = { max_published_courses: 1, storage_gb: 1, reels_per_day: 1, analytics_level: "basic", creator_coupons: false, org_seats: 0 };

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Fix round 1: reactivation, stale events, concurrency, org notification target, production cache busting. No manual entitlements invalidation anywhere. */
describe("subscription state hardening", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let ent: EntitlementsService;
  let subs: SubscriptionsService;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const creator = async () => {
    const s = await t.login();
    await t.app.get(CreatorService).becomeCreator(s.userId);
    return s;
  };
  const versionOf = (planKey: string) => prisma.planVersion.findFirstOrThrow({ where: { plan: { key: planKey }, interval: "MONTH" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const checkout = (s: Session, planVersionId: string) => http().post("/v1/subscriptions/checkout").set(auth(s)).send({ planVersionId });

  async function deliver(type: string, rzpSubId: string, opts: { payment?: { id: string; amount: number }; periodEndMs?: number } = {}) {
    const entity = { id: rzpSubId, plan_id: "plan_x", status: "active", notes: { nonce: uid() }, current_end: opts.periodEndMs ? Math.floor(opts.periodEndMs / 1000) : undefined };
    const payload: Record<string, unknown> = { subscription: { entity } };
    if (opts.payment) payload.payment = { entity: { id: opts.payment.id, amount: opts.payment.amount, status: "captured" } };
    const hook = fake.webhook(type, payload);
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } } });
    await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
  }
  const pay = (amount: number) => ({ id: `pay_${uid()}`, amount });

  async function subscribed(planKey = "pro") {
    const s = await creator();
    const v = await versionOf(planKey);
    const res = await checkout(s, v.id);
    const payment = pay(Number(v.pricePaise));
    await deliver("subscription.charged", res.body.razorpaySubscriptionId, { payment, periodEndMs: t.clock.now().getTime() + 30 * DAY });
    return { s, payment, sub: res.body as { subscriptionId: string; razorpaySubscriptionId: string } };
  }

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    ent = t.app.get(EntitlementsService);
    subs = t.app.get(SubscriptionsService);
  });
  afterAll(() => t?.close());

  // These two run first: the checkout reuse window compares DB timestamps with the app clock, which later tests move forward.
  it("concurrent first checkouts of a never-planned version make one Razorpay plan and one subscription", async () => {
    const s = await creator();
    const plan = await prisma.plan.create({ data: { key: `conc_${uid()}`, name: "Conc", audience: "CREATOR" } });
    const v = await prisma.planVersion.create({ data: { planId: plan.id, pricePaise: 12300n, interval: "MONTH", commissionBps: 800, limits: LIMITS } });
    const plansBefore = fake.callsTo("createPlan").length;
    const subsBefore = fake.callsTo("createSubscription").length;
    const results = await Promise.all([checkout(s, v.id), checkout(s, v.id), checkout(s, v.id)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.subscriptionId)).size).toBe(1);
    expect(fake.callsTo("createPlan").length - plansBefore).toBe(1);
    expect(fake.callsTo("createSubscription").length - subsBefore).toBe(1);
    expect(await prisma.subscription.count({ where: { ownerType: "USER", ownerId: s.userId, planVersionId: v.id } })).toBe(1);
    expect((await prisma.planVersion.findUniqueOrThrow({ where: { id: v.id } })).razorpayPlanId).toMatch(/^plan_/);
  });

  it("concurrent first checkouts by different owners of one version still create a single Razorpay plan", async () => {
    const [a, b] = [await creator(), await creator()];
    const plan = await prisma.plan.create({ data: { key: `conc2_${uid()}`, name: "Conc2", audience: "CREATOR" } });
    const v = await prisma.planVersion.create({ data: { planId: plan.id, pricePaise: 45600n, interval: "MONTH", commissionBps: 800, limits: LIMITS } });
    const before = fake.callsTo("createPlan").length;
    const results = await Promise.all([checkout(a, v.id), checkout(b, v.id)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(fake.callsTo("createPlan").length - before).toBe(1);
  });

  it("a charge for a CANCELLED subscription reactivates it with the new period end, and notifies", async () => {
    const { s, sub } = await subscribed("pro");
    await http().post(`/v1/subscriptions/${sub.subscriptionId}/cancel`).set(auth(s)).expect(200);
    await deliver("subscription.cancelled", sub.razorpaySubscriptionId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).status).toBe("CANCELLED");
    const end = t.clock.now().getTime() + 90 * DAY;
    await deliver("subscription.charged", sub.razorpaySubscriptionId, { payment: pay(99900), periodEndMs: end });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
    expect(row).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: false, graceEndsAt: null });
    expect(row.currentPeriodEnd!.getTime()).toBe(Math.floor(end / 1000) * 1000);
    const events = (await prisma.outboxEvent.findMany({ where: { type: "subscription.changed" } })).map((e) => e.payload as { subscriptionId?: string; change?: string });
    expect(events.filter((e) => e.subscriptionId === sub.subscriptionId && e.change === "activated").length).toBeGreaterThanOrEqual(2);
  });

  it("a late charge for an EXPIRED subscription brings it back and the cache follows", async () => {
    const { s, sub } = await subscribed("pro");
    await deliver("subscription.halted", sub.razorpaySubscriptionId);
    t.clock.advance(4 * DAY);
    await subs.runMaintenance();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).status).toBe("EXPIRED");
    expect((await ent.planFor("USER", s.userId)).planKey).toBe("free");
    await deliver("subscription.charged", sub.razorpaySubscriptionId, { payment: pay(99900), periodEndMs: t.clock.now().getTime() + 30 * DAY });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).status).toBe("ACTIVE");
    expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro");
  });

  it("a stale or reordered activated/charged event does not un-halt a PAST_DUE subscription", async () => {
    const { payment, sub } = await subscribed("pro");
    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
    await deliver("subscription.halted", sub.razorpaySubscriptionId);
    await deliver("subscription.charged", sub.razorpaySubscriptionId, { payment, periodEndMs: before.currentPeriodEnd!.getTime() });
    await deliver("subscription.activated", sub.razorpaySubscriptionId);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
    expect(row.status).toBe("PAST_DUE");
    expect(row.graceEndsAt).not.toBeNull();
    expect(await prisma.journalEntry.count({ where: { refType: "SUBSCRIPTION_CHARGE", refId: payment.id } })).toBe(1);
  });

  it("an organization subscription event carries the user to notify", async () => {
    const ownerS = await t.login();
    const org = (await http().post("/v1/orgs").set(auth(ownerS)).send({ name: "Notify Org", slug: `nt-${uid()}` })).body as { id: string; slug: string };
    const v = await versionOf("org_starter");
    const res = await http().post(`/v1/orgs/${org.slug}/subscription/checkout`).set(auth(ownerS)).send({ planVersionId: v.id });
    await deliver("subscription.charged", res.body.razorpaySubscriptionId, { payment: pay(Number(v.pricePaise)), periodEndMs: t.clock.now().getTime() + 30 * DAY });
    const events = (await prisma.outboxEvent.findMany({ where: { type: "subscription.changed" } })).map((e) => e.payload as { subscriptionId?: string; notifyUserId?: string });
    expect(events.find((p) => p.subscriptionId === res.body.subscriptionId)?.notifyUserId).toBe(ownerS.userId);
  });

  it("state changes bust the entitlements cache by themselves (charge, failure, grace expiry, cancel)", async () => {
    const s = await creator();
    expect((await ent.planFor("USER", s.userId)).planKey).toBe("free"); // warms the cache
    const res = await checkout(s, (await versionOf("pro")).id);
    await deliver("subscription.charged", res.body.razorpaySubscriptionId, { payment: pay(99900), periodEndMs: t.clock.now().getTime() + 30 * DAY });
    expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro");
    await deliver("subscription.halted", res.body.razorpaySubscriptionId);
    expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro"); // grace
    t.clock.advance(4 * DAY);
    await subs.runMaintenance();
    expect((await ent.planFor("USER", s.userId)).planKey).toBe("free");

    const s2 = await creator();
    const r2 = await checkout(s2, (await versionOf("pro")).id);
    await deliver("subscription.charged", r2.body.razorpaySubscriptionId, { payment: pay(99900), periodEndMs: t.clock.now().getTime() + 30 * DAY });
    expect((await ent.planFor("USER", s2.userId)).planKey).toBe("pro");
    await http().post(`/v1/subscriptions/${r2.body.subscriptionId}/cancel`).set(auth(s2)).expect(200);
    t.clock.advance(31 * DAY);
    await subs.runMaintenance();
    expect((await ent.planFor("USER", s2.userId)).planKey).toBe("free");
  });

  it("the webhook path applies a booked downgrade when the next cycle is charged", async () => {
    const { s, sub } = await subscribed("business");
    const proV = await versionOf("pro");
    await http().post(`/v1/subscriptions/${sub.subscriptionId}/change`).set(auth(s)).send({ planVersionId: proV.id }).expect(200);
    await deliver("subscription.charged", sub.razorpaySubscriptionId, { payment: pay(Number(proV.pricePaise)), periodEndMs: t.clock.now().getTime() + 61 * DAY });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
    expect(row).toMatchObject({ planVersionId: proV.id, scheduledPlanVersionId: null, status: "ACTIVE" });
    expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "pro", commissionBps: 700 });
  });
});
