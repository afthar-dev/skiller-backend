import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EventBus } from "../../src/common/outbox/event-bus";
import { EntitlementsService, FakeRazorpayClient, RAZORPAY_CLIENT, SubscriptionsService } from "../../src/modules/billing";
import { CreatorService } from "../../src/modules/users";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { givePlan } from "../support/billing";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uid = () => randomUUID().replace(/-/g, "").slice(0, 10);
const DAY = 86400_000;

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("creator subscriptions (Razorpay Subscriptions)", () => {
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
  const versionOf = (planKey: string, interval: "MONTH" | "YEAR" = "MONTH") =>
    prisma.planVersion.findFirstOrThrow({ where: { plan: { key: planKey }, interval }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const checkout = (s: Session, planVersionId: string) => http().post("/v1/subscriptions/checkout").set(auth(s)).send({ planVersionId });
  const owner = (s: Session) => ({ ownerType: "USER" as const, ownerId: s.userId });

  /** Delivers a signed subscription webhook through the real endpoint and waits until the billing worker has processed it. */
  async function deliver(type: string, rzpSubId: string, opts: { payment?: { id: string; amount: number }; periodEndMs?: number; eventId?: string } = {}) {
    const entity = { id: rzpSubId, plan_id: "plan_x", status: "active", current_end: opts.periodEndMs ? Math.floor(opts.periodEndMs / 1000) : undefined };
    const payload: Record<string, unknown> = { subscription: { entity } };
    if (opts.payment) payload.payment = { entity: { id: opts.payment.id, amount: opts.payment.amount, status: "captured" } };
    const hook = fake.webhook(type, payload, { eventId: opts.eventId });
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } } });
    await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
    return row;
  }

  /** Checks out `planKey` for a fresh creator and delivers the first charge. */
  async function subscribed(planKey = "pro", interval: "MONTH" | "YEAR" = "MONTH") {
    const s = await creator();
    const v = await versionOf(planKey, interval);
    const res = await checkout(s, v.id);
    expect(res.status).toBe(201);
    const payment = { id: `pay_${uid()}`, amount: Number(v.pricePaise) };
    await deliver("subscription.charged", res.body.razorpaySubscriptionId, { payment, periodEndMs: t.clock.now().getTime() + 30 * DAY });
    return { s, v, payment, sub: res.body as { subscriptionId: string; razorpaySubscriptionId: string } };
  }

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    ent = t.app.get(EntitlementsService);
    subs = t.app.get(SubscriptionsService);
  });
  afterAll(() => t?.close());

  describe("checkout", () => {
    it("creates the Razorpay plan lazily (cached on the version) and an INCOMPLETE subscription; a repeat click reuses it", async () => {
      const s = await creator();
      const v = await versionOf("business", "YEAR");
      const before = fake.callsTo("createPlan").length;
      const res = await checkout(s, v.id);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ subscriptionId: expect.any(String), razorpaySubscriptionId: expect.stringMatching(/^sub_/), keyId: "rzp_test_key" });
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: res.body.subscriptionId } });
      expect(row).toMatchObject({ status: "INCOMPLETE", ownerType: "USER", ownerId: s.userId, planVersionId: v.id });
      expect((await prisma.planVersion.findUniqueOrThrow({ where: { id: v.id } })).razorpayPlanId).toMatch(/^plan_/);
      const second = await checkout(s, v.id);
      expect(second.body.subscriptionId).toBe(res.body.subscriptionId);
      expect(fake.callsTo("createPlan").length - before).toBeLessThanOrEqual(1);
      // not entitled until the first charge
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("free");
    });

    it("needs a creator (CREATOR_REQUIRED), a purchasable plan and a matching audience", async () => {
      const plain = await t.login();
      const v = await versionOf("pro");
      const denied = await checkout(plain, v.id);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("CREATOR_REQUIRED");
      const s = await creator();
      expect((await checkout(s, (await versionOf("free")).id)).body.error.code).toBe("PLAN_NOT_PURCHASABLE");
      expect((await checkout(s, (await versionOf("org_starter")).id)).body.error.code).toBe("PLAN_AUDIENCE_MISMATCH");
      expect((await checkout(s, randomUUID())).status).toBe(404);
    });

    it("an organization checks out through its own routes, guarded by org.manage", async () => {
      const ownerS = await t.login();
      const org = (await http().post("/v1/orgs").set(auth(ownerS)).send({ name: "Pay Org", slug: `pay-${uid()}` })).body as { id: string; slug: string };
      const v = await versionOf("org_starter");
      const other = await t.login();
      expect((await http().post(`/v1/orgs/${org.slug}/subscription/checkout`).set(auth(other)).send({ planVersionId: v.id })).status).toBe(403);
      const res = await http().post(`/v1/orgs/${org.slug}/subscription/checkout`).set(auth(ownerS)).send({ planVersionId: v.id });
      expect(res.status).toBe(201);
      expect(await prisma.subscription.count({ where: { id: res.body.subscriptionId, ownerType: "ORG", ownerId: org.id } })).toBe(1);
      const creatorPlan = await versionOf("pro");
      expect((await http().post(`/v1/orgs/${org.slug}/subscription/checkout`).set(auth(ownerS)).send({ planVersionId: creatorPlan.id })).body.error.code).toBe("PLAN_AUDIENCE_MISMATCH");
    });
  });

  describe("webhooks", () => {
    it("subscription.charged activates Pro and posts the ledger split (999 INR -> revenue 84661, tax 15239)", async () => {
      const { s, payment, sub } = await subscribed("pro");
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
      expect(row.status).toBe("ACTIVE");
      expect(row.currentPeriodEnd).not.toBeNull();
      await ent.invalidate(owner(s));
      expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "pro", commissionBps: 700 });

      const entry = await prisma.journalEntry.findFirstOrThrow({ where: { refType: "SUBSCRIPTION_CHARGE", refId: payment.id }, include: { lines: { include: { account: true } } } });
      const byKind = Object.fromEntries(entry.lines.map((l) => [l.account.kind, l.amountPaise]));
      expect(byKind).toEqual({ GATEWAY_CLEARING: -99900n, PLATFORM_REVENUE: 84661n, TAX_PAYABLE: 15239n });
      const changed = await prisma.outboxEvent.findMany({ where: { type: "subscription.changed" } });
      expect(changed.some((e) => (e.payload as { subscriptionId?: string }).subscriptionId === sub.subscriptionId)).toBe(true);
    });

    it("a duplicate charged webhook (same event, or a new event for the same payment) leaves one ledger entry", async () => {
      const { payment, sub } = await subscribed("pro");
      const dupe = await deliver("subscription.charged", sub.razorpaySubscriptionId, { payment, periodEndMs: Date.now() + 30 * DAY });
      await deliver("subscription.activated", sub.razorpaySubscriptionId, { payment, periodEndMs: Date.now() + 30 * DAY });
      expect(dupe.id).toBeTruthy();
      expect(await prisma.journalEntry.count({ where: { refType: "SUBSCRIPTION_CHARGE", refId: payment.id } })).toBe(1);
    });

    it("an unknown subscription id is acknowledged, not retried forever", async () => {
      const row = await deliver("subscription.charged", `sub_unknown_${uid()}`, { payment: { id: `pay_${uid()}`, amount: 100 } });
      const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.processedAt).not.toBeNull();
      expect(after.lastError).toBeNull();
    });

    it("halted -> PAST_DUE keeps Pro (700 bps) for 3 days, then the owner is on Free", async () => {
      const { s, sub } = await subscribed("pro");
      await deliver("subscription.halted", sub.razorpaySubscriptionId);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
      expect(row.status).toBe("PAST_DUE");
      expect(row.graceEndsAt!.getTime()).toBe(t.clock.now().getTime() + 3 * DAY);
      await ent.invalidate(owner(s));
      expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "pro", commissionBps: 700 });

      // a second failure notice does not extend the grace period
      await deliver("subscription.pending", sub.razorpaySubscriptionId);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).graceEndsAt).toEqual(row.graceEndsAt);

      t.clock.advance(3 * DAY - 1000);
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro");
      t.clock.advance(2000);
      await ent.invalidate(owner(s));
      expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "free", commissionBps: 1000 });

      await subs.runMaintenance();
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).status).toBe("EXPIRED");
      expect(await prisma.subscription.count({ where: { ownerType: "USER", ownerId: s.userId, status: "ACTIVE", razorpaySubscriptionId: null } })).toBe(1);
      await subs.runMaintenance(); // repeat run is a no-op
      expect(await prisma.subscription.count({ where: { ownerType: "USER", ownerId: s.userId, status: "ACTIVE", razorpaySubscriptionId: null } })).toBe(1);
    });

    it("a payment after PAST_DUE brings the subscription back to ACTIVE and clears the grace period", async () => {
      const { sub } = await subscribed("pro");
      await deliver("subscription.halted", sub.razorpaySubscriptionId);
      await deliver("subscription.charged", sub.razorpaySubscriptionId, { payment: { id: `pay_${uid()}`, amount: 99900 }, periodEndMs: t.clock.now().getTime() + 60 * DAY });
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
      expect(row).toMatchObject({ status: "ACTIVE", graceEndsAt: null });
    });

    it("an order checkout during the grace period would use Pro commission (planFor is the snapshot source)", async () => {
      const { s, sub } = await subscribed("pro");
      await deliver("subscription.pending", sub.razorpaySubscriptionId);
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).commissionBps).toBe(700);
    });
  });

  describe("cancel and change", () => {
    it("cancel books the end of the period (Razorpay cycle-end cancel); the cancelled webhook keeps access until then", async () => {
      const { s, sub } = await subscribed("pro");
      const res = await http().post(`/v1/subscriptions/${sub.subscriptionId}/cancel`).set(auth(s));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cancelAtPeriodEnd: true, plan: { key: "pro" } });
      expect(fake.callsTo("cancelSubscription").some((c) => c.args[0] === sub.razorpaySubscriptionId && c.args[1] === true)).toBe(true);
      expect((await http().post(`/v1/subscriptions/${sub.subscriptionId}/cancel`).set(auth(s))).status).toBe(200); // idempotent

      await deliver("subscription.cancelled", sub.razorpaySubscriptionId);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).status).toBe("CANCELLED");
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro");

      t.clock.advance(31 * DAY);
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("free");
      await subs.runMaintenance();
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).status).toBe("EXPIRED");
    });

    it("only the owner can see or cancel a subscription (404 for others)", async () => {
      const { sub } = await subscribed("pro");
      const other = await creator();
      expect((await http().post(`/v1/subscriptions/${sub.subscriptionId}/cancel`).set(auth(other))).status).toBe(404);
    });

    it("a downgrade is scheduled for the period end, not applied now", async () => {
      const { s, sub } = await subscribed("business");
      const proV = await versionOf("pro");
      const res = await http().post(`/v1/subscriptions/${sub.subscriptionId}/change`).set(auth(s)).send({ planVersionId: proV.id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ effective: "AT_PERIOD_END", scheduledPlanVersionId: proV.id });
      expect(fake.callsTo("updateSubscription").some((c) => c.args[0] === sub.razorpaySubscriptionId)).toBe(true);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
      expect(row.scheduledPlanVersionId).toBe(proV.id);
      await ent.invalidate(owner(s));
      expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "business", commissionBps: 500 });

      t.clock.advance(31 * DAY);
      await subs.runMaintenance();
      await ent.invalidate(owner(s));
      expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "pro", commissionBps: 700 });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } })).scheduledPlanVersionId).toBeNull();
    });

    it("a downgrade to Free cancels at cycle end and lands on Free at the period end", async () => {
      const { s, sub } = await subscribed("pro");
      const res = await http().post(`/v1/subscriptions/${sub.subscriptionId}/change`).set(auth(s)).send({ planVersionId: (await versionOf("free")).id });
      expect(res.body.effective).toBe("AT_PERIOD_END");
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro");
      t.clock.advance(31 * DAY);
      await subs.runMaintenance();
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("free");
    });

    it("an upgrade opens a new Razorpay subscription; its first charge takes over and the old one is cancelled at cycle end", async () => {
      const { s, sub } = await subscribed("pro");
      const bizV = await versionOf("business");
      const res = await http().post(`/v1/subscriptions/${sub.subscriptionId}/change`).set(auth(s)).send({ planVersionId: bizV.id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ effective: "ON_PAYMENT", razorpaySubscriptionId: expect.stringMatching(/^sub_/) });
      await ent.invalidate(owner(s));
      expect((await ent.planFor("USER", s.userId)).planKey).toBe("pro"); // until paid

      await deliver("subscription.charged", res.body.razorpaySubscriptionId, { payment: { id: `pay_${uid()}`, amount: Number(bizV.pricePaise) }, periodEndMs: t.clock.now().getTime() + 30 * DAY });
      await ent.invalidate(owner(s));
      expect(await ent.planFor("USER", s.userId)).toMatchObject({ planKey: "business", commissionBps: 500 });
      const old = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.subscriptionId } });
      expect(old).toMatchObject({ status: "EXPIRED", cancelAtPeriodEnd: true });
      expect(fake.callsTo("cancelSubscription").some((c) => c.args[0] === sub.razorpaySubscriptionId && c.args[1] === true)).toBe(true);
    });

    it("an upgrade from the Free row works like a checkout", async () => {
      const s = await creator();
      await subs.ensureFreeFor(owner(s));
      const free = await prisma.subscription.findFirstOrThrow({ where: { ownerType: "USER", ownerId: s.userId, razorpaySubscriptionId: null } });
      const res = await http().post(`/v1/subscriptions/${free.id}/change`).set(auth(s)).send({ planVersionId: (await versionOf("pro")).id });
      expect(res.body.effective).toBe("ON_PAYMENT");
      expect((await http().post(`/v1/subscriptions/${free.id}/cancel`).set(auth(s))).body.error.code).toBe("SUBSCRIPTION_NOT_CANCELLABLE");
    });
  });

  describe("me and free rows", () => {
    it("GET /subscriptions/me shows plan, status, period end, limits and usage", async () => {
      const { s } = await subscribed("pro");
      await ent.invalidate(owner(s));
      const res = await http().get("/v1/subscriptions/me").set(auth(s));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ plan: { key: "pro", commissionBps: 700 }, status: "ACTIVE", limits: { storage_gb: 100 }, usage: { storage_gb: { used: 0, limit: 100 * 1024 ** 3, unit: "bytes" } } });
      expect(res.body.currentPeriodEnd).toEqual(expect.any(String));
      const fresh = await creator();
      expect((await http().get("/v1/subscriptions/me").set(auth(fresh))).body).toMatchObject({ plan: { key: "free" }, status: "ACTIVE", subscriptionId: null });
    });

    it("user.became_creator and org.created each create one Free ACTIVE row (idempotent)", async () => {
      const bus = t.app.get(EventBus);
      const userId = randomUUID();
      const orgId = randomUUID();
      for (let i = 0; i < 2; i++) {
        await bus.dispatch({ type: "user.became_creator", userId });
        await bus.dispatch({ type: "org.created", orgId, ownerId: userId });
      }
      expect(await prisma.subscription.count({ where: { ownerType: "USER", ownerId: userId, status: "ACTIVE", razorpaySubscriptionId: null } })).toBe(1);
      expect(await prisma.subscription.count({ where: { ownerType: "ORG", ownerId: orgId, status: "ACTIVE", razorpaySubscriptionId: null } })).toBe(1);
    });

    it("storage usage counts PENDING and processed assets for the owner", async () => {
      const { s } = await subscribed("pro");
      await givePlan(prisma, "ORG", randomUUID(), "org_growth"); // unrelated owner: must not matter
      const r = await http().post("/v1/media/uploads").set(auth(s)).send({ purpose: "course_lesson", filename: "a.mp4", mime: "video/mp4", size: 1048576 });
      expect(r.status).toBe(201);
      await ent.invalidate(owner(s));
      const me = await http().get("/v1/subscriptions/me").set(auth(s));
      expect(me.body.usage.storage_gb.used).toBe(1048576);
    });
  });
});
