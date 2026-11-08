import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import request from "supertest";
import { AppError } from "../../src/common/errors/app-error";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import * as sentryModule from "../../src/common/observability/sentry";
import { CouponsService, FakeRazorpayClient, HoldReleaseProcessor, InvoiceIssuer, RAZORPAY_CLIENT, RazorpayApiError, WebhookProcessor } from "../../src/modules/billing";
import { RolesService } from "../../src/modules/rbac";
import { AccountsService, LedgerService } from "../../src/modules/wallet";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { entryLines, paidOrder, type Session } from "../support/orders";
import { testState, TestItemProvider } from "../support/test-item";
import { expectDeclared } from "../support/openapi-shape";

const DAY = 86_400_000;

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("refunds", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  let release: HoldReleaseProcessor;
  let ledger: LedgerService;
  let admin: Session;
  let adminAt = 0;
  const financeAdmins: string[] = [];
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const pay = (opts: Parameters<typeof paidOrder>[2] = {}) => paidOrder(t, fake, opts);

  /** The finance admin, re-authenticated (login + step-up) whenever the fake clock has moved on enough to expire the tokens. */
  async function finance(): Promise<Session> {
    if (!admin || t.clock.now().getTime() - adminAt > 3 * 60_000) {
      admin = await t.login(); // a new account each time: OTP requests are rate limited per address
      if (!financeAdmins.includes(admin.userId)) {
        await t.app.get(RolesService).grantSystem(admin.userId, "finance_admin");
        financeAdmins.push(admin.userId);
      }
      await stepUp(admin);
      adminAt = t.clock.now().getTime();
    }
    return admin;
  }

  async function stepUp(session: Session) {
    const before = t.mail.sent.filter((m) => m.to === session.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(session)).set("X-Forwarded-For", uniqueIp());
    expect(res.status).toBe(202);
    const code = await t.codeFor(session.email, before);
    await http().post("/v1/auth/step-up/verify").set(auth(session)).send({ challengeId: res.body.challengeId, code }).expect(204);
  }

  const requestRefund = (buyer: Session, orderId: string, body: object = { reason: "Not what I expected" }, key: string = randomUUID()) =>
    http().post(`/v1/orders/${orderId}/refund-requests`).set(auth(buyer)).set("Idempotency-Key", key).send(body);
  // Sessions are resolved BEFORE the request object exists: supertest closes the shared server when any one request ends.
  const approve = async (id: string, who?: Session) => {
    const as = who ?? (await finance());
    return http().post(`/v1/admin/refunds/${id}/approve`).set(auth(as)).send({});
  };
  const reject = async (id: string, who?: Session) => {
    const as = who ?? (await finance());
    return http().post(`/v1/admin/refunds/${id}/reject`).set(auth(as)).send({ note: "Outside policy" });
  };

  /** Posts a refund.* webhook for a Razorpay refund and returns its stored row (not waiting for processing). */
  async function sendRefundWebhook(type: "refund.processed" | "refund.failed", entity: { id: string; paymentId: string; amountPaise: bigint; notes?: Record<string, string> }) {
    const hook = fake.webhook(type, { refund: { entity: { id: entity.id, payment_id: entity.paymentId, amount: Number(entity.amountPaise), status: type === "refund.processed" ? "processed" : "failed", notes: { nonce: randomUUID(), ...(entity.notes ?? {}) } } } });
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    return prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } } });
  }
  async function deliverRefundWebhook(type: "refund.processed" | "refund.failed", refundId: string) {
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { order: true } });
    const row = await sendRefundWebhook(type, { id: refund.razorpayRefundId!, paymentId: refund.order.razorpayPaymentId!, amountPaise: refund.amountPaise });
    await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
  }

  /** Request as the buyer, approve as admin; returns the PROCESSING refund. */
  async function approvedRefund(o: Awaited<ReturnType<typeof pay>>, askedId?: string) {
    let id = askedId;
    if (!id) {
      const asked = await requestRefund(o.buyer, o.orderId);
      expect(asked.status).toBe(201);
      id = asked.body.id as string;
    }
    const res = await approve(id);
    expect(res.status).toBe(200);
    return prisma.refund.findUniqueOrThrow({ where: { id } });
  }

  // hold_days is a global setting in a shared database: written straight to the table (SettingsService.set leaves audit rows other suites count) and removed after.
  async function withHoldDays<T>(days: number, run: () => Promise<T>): Promise<T> {
    const redis = t.app.get<import("ioredis").Redis>((await import("../../src/common/redis/redis.constants")).REDIS);
    await prisma.platformSetting.upsert({ where: { key: "hold_days" }, create: { key: "hold_days", value: days }, update: { value: days } });
    await redis.del("settings:hold_days");
    try {
      return await run();
    } finally {
      await prisma.platformSetting.deleteMany({ where: { key: "hold_days" } });
      await redis.del("settings:hold_days");
    }
  }

  const balances = (userId: string) => ledger.balancesFor("USER", userId);

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
    release = t.app.get(HoldReleaseProcessor);
    ledger = t.app.get(LedgerService);
    await finance();
  });
  afterAll(() => t?.close());
  beforeEach(() => {
    testState.failOnPaid = null;
    testState.writeMarkerBeforeFail = false;
  });

  describe("POST /v1/orders/:id/refund-requests", () => {
    it("creates a REQUESTED full refund for the buyer's paid order, replays the same response for a repeated key and refuses a second live request", async () => {
      const o = await pay({ pricePaise: 250000n });
      const key = randomUUID();
      const res = await requestRefund(o.buyer, o.orderId, { reason: "Changed my mind" }, key);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ orderId: o.orderId, status: "REQUESTED", amountPaise: "250000", currency: "INR", reason: "Changed my mind" });
      const replay = await requestRefund(o.buyer, o.orderId, { reason: "Changed my mind" }, key);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(res.body.id);
      expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(1);

      const again = await requestRefund(o.buyer, o.orderId);
      expect(again.status).toBe(422);
      expect(again.body.error.code).toBe("REFUND_NOT_ELIGIBLE");
      expect((await requestRefund(o.buyer, o.orderId, {}, randomUUID())).status).toBe(400);
    });

    it("requires an Idempotency-Key and authentication, and is 404 for somebody else's order", async () => {
      const o = await pay();
      const missing = await http().post(`/v1/orders/${o.orderId}/refund-requests`).set(auth(o.buyer)).send({ reason: "x" });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((await http().post(`/v1/orders/${o.orderId}/refund-requests`).set("Idempotency-Key", randomUUID()).send({ reason: "x" })).status).toBe(401);
      const stranger = await t.login();
      const res = await requestRefund(stranger, o.orderId);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    });

    it("is REFUND_NOT_ELIGIBLE after 7 days, and for an order that is not paid", async () => {
      const late = await pay();
      t.clock.advance(7 * DAY + 1000);
      const res = await requestRefund(await t.login(late.buyer.email), late.orderId);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("REFUND_NOT_ELIGIBLE");

      const buyer = await t.login();
      const seller = await t.login();
      const { createTestItem } = await import("../support/test-item");
      const itemId = createTestItem({ sellerOwnerId: seller.userId });
      const started = await http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId });
      expect(started.status).toBe(201);
      const unpaid = await requestRefund(buyer, started.body.orderId);
      expect(unpaid.status).toBe(422);
      expect(unpaid.body.error.code).toBe("REFUND_NOT_ELIGIBLE");
    });
  });

  describe("admin endpoints", () => {
    it("need billing.refund and a fresh step-up", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      expect((await approve(asked.body.id, o.buyer)).status).toBe(403);
      expect((await http().get("/v1/admin/refunds").set(auth(o.buyer))).status).toBe(403);

      const staff = await t.login();
      await t.app.get(RolesService).grantSystem(staff.userId, "finance_admin");
      const noStepUp = await approve(asked.body.id, staff);
      expect(noStepUp.status).toBe(403);
      expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
      expect((await reject(asked.body.id, staff)).body.error.code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "REQUESTED" });
    });

    it("lists refunds by status for finance", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      const as = await finance();
      const res = await http().get("/v1/admin/refunds?status=REQUESTED&limit=100").set(auth(as));
      expect(res.status).toBe(200);
      expect(res.body.items.map((r: { id: string }) => r.id)).toContain(asked.body.id);
      expect(res.body.items.every((r: { status: string }) => r.status === "REQUESTED")).toBe(true);
    });

    it("approve starts the Razorpay refund once (idempotency key = refund id), stores PROCESSING with the Razorpay id and audits it", async () => {
      const o = await pay({ pricePaise: 120000n });
      const calls = fake.callsTo("createRefund").length;
      const refund = await approvedRefund(o);
      expect(refund).toMatchObject({ status: "PROCESSING", decidedBy: admin.userId, amountPaise: 120000n });
      expect(refund.razorpayRefundId).toMatch(/^rfnd_/);
      const made = fake.callsTo("createRefund").slice(calls);
      expect(made).toHaveLength(1);
      expect(made[0].args[0]).toBe(o.paymentId);
      expect(made[0].args[1]).toMatchObject({ amountPaise: 120000n, idempotencyKey: refund.id });

      // a second approve does not call Razorpay again
      const twice = await approve(refund.id);
      expect(twice.status).toBe(200);
      expect(twice.body.status).toBe("PROCESSING");
      expect(fake.callsTo("createRefund").slice(calls)).toHaveLength(1);

      const audit = await prisma.auditLog.findFirst({ where: { action: "refund.approve", targetId: refund.id } });
      expect(audit).toMatchObject({ actorId: admin.userId, targetType: "refund" });
    });

    it("reject closes a REQUESTED refund, tells the buyer, cannot be repeated, and lets the buyer ask again", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      const res = await reject(asked.body.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("REJECTED");
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "REJECTED", decidedBy: admin.userId });
      expect(await prisma.auditLog.count({ where: { action: "refund.reject", targetId: asked.body.id } })).toBe(1);
      expect(fake.callsTo("createRefund").some((c) => (c.args[1] as { idempotencyKey?: string }).idempotencyKey === asked.body.id)).toBe(false);
      const again = await reject(asked.body.id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("REFUND_NOT_PENDING");
      expect((await approve(asked.body.id)).status).toBe(409);
      expect((await requestRefund(o.buyer, o.orderId)).status).toBe(201);
      const notes = await prisma.notification.findMany({ where: { userId: o.buyer.userId, type: "refund.rejected" } });
      expect(notes).toHaveLength(1);
    });

    it("a Razorpay outage leaves the refund APPROVED (502) and approving again finishes it; a rejected request is FAILED with its reason", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      fake.failNext.set("createRefund", new RazorpayApiError(503, null, "down"));
      const down = await approve(asked.body.id);
      expect(down.status).toBe(502);
      expect(down.body.error.code).toBe("REFUND_GATEWAY_ERROR");
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "APPROVED", razorpayRefundId: null });
      const retried = await approve(asked.body.id);
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe("PROCESSING");

      const o2 = await pay();
      const asked2 = await requestRefund(o2.buyer, o2.orderId);
      fake.failNext.set("createRefund", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "The payment has been fully refunded already"));
      const refusedByGateway = await approve(asked2.body.id);
      expect(refusedByGateway.status).toBe(200);
      expect(refusedByGateway.body.status).toBe("FAILED");
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: asked2.body.id } })).failureReason).toContain("fully refunded");
    });
  });

  describe("refund.processed", () => {
    it("before the hold was released: reverses the sale exactly, from the seller's PENDING; refunds the order, undoes the delivery and frees the coupon", async () => {
      const o = await pay({ pricePaise: 100000n });
      // a coupon on the same order is covered below; here the plain reversal
      const sale = (await entryLines(prisma, o.orderId, "sale"))!;
      const refund = await approvedRefund(o);
      await deliverRefundWebhook("refund.processed", refund.id);

      const rev = (await entryLines(prisma, o.orderId, "refund"))!;
      expect(rev.entry).toMatchObject({ refType: "ORDER", refId: o.orderId, description: "refund" });
      expect(rev.sum).toBe(0n);
      expect(Object.fromEntries(Object.entries(rev.byKind).map(([k, v]) => [k, -v]))).toEqual(sale.byKind);
      expect(rev.byKind.AVAILABLE).toBeUndefined();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "REFUNDED" });
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: "PROCESSED" });
      expect(testState.refunded).toContain(o.orderId);
      expect((await balances(o.seller.userId)).PENDING).toBe(0n);
      expect(await prisma.outboxEvent.count({ where: { type: "order.refunded", payload: { path: ["orderId"], equals: o.orderId } } })).toBe(1);

      // the hold job leaves a refunded order alone
      t.clock.advance(8 * DAY);
      await release.releaseDue();
      expect(await entryLines(prisma, o.orderId, "hold_release")).toBeNull();
    });

    it("a duplicate refund.processed (same or new event id) posts one reversal", async () => {
      const o = await pay();
      const refund = await approvedRefund(o);
      await deliverRefundWebhook("refund.processed", refund.id);
      await deliverRefundWebhook("refund.processed", refund.id);
      expect(await prisma.journalEntry.count({ where: { refType: "ORDER", refId: o.orderId, description: "refund" } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { type: "order.refunded", payload: { path: ["orderId"], equals: o.orderId } } })).toBe(1);
      expect(testState.refunded.filter((id) => id === o.orderId)).toHaveLength(1);
    });

    it("after the hold was released: reverses from the seller's AVAILABLE", async () => {
      const o = await pay();
      const sale = (await entryLines(prisma, o.orderId, "sale"))!;
      const share = sale.byKind.PENDING;
      // hold_days 3: the hold ends on day 3, inside the 7 day refund window (a live refund would keep the hold)
      const buyer = await withHoldDays(3, async () => {
        t.clock.advance(4 * DAY);
        await release.releaseDue();
        expect(await entryLines(prisma, o.orderId, "hold_release")).not.toBeNull();
        return t.login(o.buyer.email);
      });
      const asked = await requestRefund(buyer, o.orderId);
      expect(asked.status).toBe(201);
      const refund = await approvedRefund(o, asked.body.id);
      await deliverRefundWebhook("refund.processed", refund.id);
      const rev = (await entryLines(prisma, o.orderId, "refund"))!;
      expect(rev.sum).toBe(0n);
      expect(rev.byKind.AVAILABLE).toBe(-share);
      expect(rev.byKind.PENDING).toBeUndefined();
      expect(rev.byKind.GATEWAY_CLEARING).toBe(-sale.byKind.GATEWAY_CLEARING);
      expect(rev.byKind.PLATFORM_REVENUE).toBe(-sale.byKind.PLATFORM_REVENUE);
      expect(rev.byKind.TAX_PAYABLE).toBe(-sale.byKind.TAX_PAYABLE);
      const bal = await balances(o.seller.userId);
      expect(bal.AVAILABLE).toBe(0n);
      expect(bal.PENDING).toBe(0n);
    });

    it("after release AND payout: the seller's AVAILABLE goes negative, the ledger still balances", async () => {
      const o = await pay();
      const share = (await entryLines(prisma, o.orderId, "sale"))!.byKind.PENDING;
      await withHoldDays(3, async () => {
        t.clock.advance(4 * DAY);
        await release.releaseDue();
      });
      const buyer = await t.login(o.buyer.email);
      const asked = await requestRefund(buyer, o.orderId);
      expect(asked.status).toBe(201);
      // the seller withdraws everything that was released (a payout moves AVAILABLE out to the gateway clearing account)
      const accounts = t.app.get(AccountsService);
      await prisma.$transaction(async (tx) => {
        const seller = await accounts.ensureSellerAccounts(tx, "USER", o.seller.userId);
        const clearing = await accounts.platformAccount("GATEWAY_CLEARING", tx);
        await ledger.post(tx, { refType: "TEST_PAYOUT", refId: o.orderId, description: "payout", lines: [{ accountId: seller.AVAILABLE, amountPaise: -share }, { accountId: clearing, amountPaise: share }] });
      });
      expect((await balances(o.seller.userId)).AVAILABLE).toBe(0n);

      const refund = await approvedRefund(o, asked.body.id);
      await deliverRefundWebhook("refund.processed", refund.id);
      const bal = await balances(o.seller.userId);
      expect(bal.AVAILABLE).toBe(-share);
      expect(bal.PENDING).toBe(0n);
      const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`SELECT COALESCE(SUM("amountPaise"), 0)::bigint AS total FROM ledger_lines`;
      expect(total).toBe(0n);
      const rev = (await entryLines(prisma, o.orderId, "refund"))!;
      expect(rev.sum).toBe(0n);
    });

    it("a refund racing the hold release cannot spend the same PENDING money twice", async () => {
      for (let i = 0; i < 4; i++) {
        const o = await pay();
        const refund = await approvedRefund(o);
        t.clock.advance(8 * DAY);
        const row = await sendRefundWebhook("refund.processed", { id: refund.razorpayRefundId!, paymentId: o.paymentId, amountPaise: refund.amountPaise });
        await Promise.all([release.releaseDue(), until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt)]);
        await release.releaseDue();
        const bal = await balances(o.seller.userId);
        expect({ pending: bal.PENDING, available: bal.AVAILABLE }).toEqual({ pending: 0n, available: 0n });
        expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "REFUNDED" });
      }
    });

    it("releases the coupon use of a refunded order", async () => {
      const seller = await t.login();
      const buyer = await t.login();
      const coupons = t.app.get(CouponsService);
      const code = `REF${randomUUID().slice(0, 8).toUpperCase()}`;
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", maxUses: 5 });
      const { createTestItem } = await import("../support/test-item");
      const itemId = createTestItem({ sellerOwnerId: seller.userId, pricePaise: 100000n });
      const started = await http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId, couponCode: code });
      expect(started.status).toBe(201);
      const payment = fake.capturePayment(started.body.razorpayOrderId);
      await http()
        .post("/v1/checkout/verify")
        .set(auth(buyer))
        .send({ orderId: started.body.orderId, razorpayOrderId: started.body.razorpayOrderId, razorpayPaymentId: payment.id, signature: fake.paymentSignature(started.body.razorpayOrderId, payment.id) })
        .expect(200);
      expect(await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: started.body.orderId } })).toMatchObject({ status: "REDEEMED" });

      const asked = await requestRefund(buyer, started.body.orderId);
      expect(asked.body.amountPaise).toBe(started.body.amountPaise);
      expect((await approve(asked.body.id)).status).toBe(200);
      await deliverRefundWebhook("refund.processed", asked.body.id);
      expect(await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: started.body.orderId } })).toMatchObject({ status: "RELEASED" });
      const rev = (await entryLines(prisma, started.body.orderId, "refund"))!;
      const sale = (await entryLines(prisma, started.body.orderId, "sale"))!;
      expect(rev.sum).toBe(0n);
      expect(Object.fromEntries(Object.entries(rev.byKind).map(([k, v]) => [k, -v]))).toEqual(sale.byKind);
    });

    it("tells the buyer (once, even if the event is redelivered)", async () => {
      const o = await pay();
      const refund = await approvedRefund(o);
      await deliverRefundWebhook("refund.processed", refund.id);
      const row = (await prisma.outboxEvent.findMany({ where: { type: "order.refunded" } })).find((x) => (x.payload as { orderId?: string }).orderId === o.orderId)!;
      const event = { type: "order.refunded" as const, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0];
      await bus.dispatch(event, row.id);
      await bus.dispatch(event, row.id);
      const notes = await prisma.notification.findMany({ where: { userId: o.buyer.userId, type: "refund.processed" } });
      expect(notes).toHaveLength(1);
    });
  });

  describe("refund.failed", () => {
    it("marks the refund FAILED, alerts finance, leaves the order PAID and the sale intact, and lets the buyer ask again", async () => {
      const o = await pay();
      const refund = await approvedRefund(o);
      await deliverRefundWebhook("refund.failed", refund.id);
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: "FAILED" });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "PAID" });
      expect(await entryLines(prisma, o.orderId, "refund")).toBeNull();
      const alert = await until(async () => (await prisma.notification.findMany({ where: { userId: { in: financeAdmins }, type: "finance.alert" } })).find((n) => (n.data as { orderId?: string; kind?: string } | null)?.orderId === o.orderId && (n.data as { kind?: string }).kind === "REFUND_FAILED"));
      expect(alert).toBeTruthy();
      expect((await requestRefund(o.buyer, o.orderId)).status).toBe(201);
    });
  });

  describe("webhooks for refunds we do not know", () => {
    it("are stored and left unprocessed so the queue retries them; a later arrival of the refund id completes them; giving up marks them processed with a warning", async () => {
      const processor = t.app.get(WebhookProcessor);
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      const razorpayRefundId = `rfnd_early_${randomUUID().slice(0, 8)}`;
      const row = await sendRefundWebhook("refund.processed", { id: razorpayRefundId, paymentId: o.paymentId, amountPaise: 100000n });
      const job = { data: { webhookEventId: row.id } } as Job<{ webhookEventId: string }>;

      await expect(processor.process(job)).rejects.toThrow(/unknown refund/i);
      const unprocessed = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
      expect(unprocessed.processedAt).toBeNull();
      expect(unprocessed.lastError).toMatch(/unknown refund/i);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "PAID" });

      // the approve call returns (and stores the id) after the webhook raced ahead: the retry now succeeds
      await prisma.refund.update({ where: { id: asked.body.id }, data: { status: "PROCESSING", razorpayRefundId } });
      await processor.process(job);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt).not.toBeNull();
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "PROCESSED" });

      // a refund id that never shows up: after the last attempt the event is closed with a warning instead of failing forever
      const ghost = await sendRefundWebhook("refund.processed", { id: `rfnd_ghost_${randomUUID().slice(0, 8)}`, paymentId: "pay_none", amountPaise: 1n });
      await processor.onExhausted({ data: { webhookEventId: ghost.id } } as Job<{ webhookEventId: string }>, new Error("unknown refund"));
      const closed = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: ghost.id } });
      expect(closed.processedAt).not.toBeNull();
      expect(closed.lastError).toMatch(/gave up|unknown refund/i);
    });
  });

  describe("automatic refund of an undelivered order", () => {
    it("order.fulfilment_failed creates an approved system refund and starts it at Razorpay once; nothing is revoked because nothing was granted", async () => {
      testState.failOnPaid = new AppError("ITEM_GONE", 422, "The item was withdrawn");
      const o = await pay({ pricePaise: 90000n });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
      expect(order.fulfilmentFailedAt).not.toBeNull();
      const row = (await prisma.outboxEvent.findMany({ where: { type: "order.fulfilment_failed" } })).find((x) => (x.payload as { orderId?: string }).orderId === o.orderId)!;
      const event = { type: "order.fulfilment_failed" as const, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0];

      const calls = fake.callsTo("createRefund").length;
      await bus.dispatch(event, row.id);
      await bus.dispatch(event, row.id);
      const refunds = await prisma.refund.findMany({ where: { orderId: o.orderId } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ status: "PROCESSING", requestedBy: "system", decidedBy: "system", amountPaise: 90000n });
      expect(refunds[0].razorpayRefundId).toMatch(/^rfnd_/);
      expect(fake.callsTo("createRefund").slice(calls)).toHaveLength(1);

      await deliverRefundWebhook("refund.processed", refunds[0].id);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "REFUNDED" });
      expect(testState.refunded).not.toContain(o.orderId);
      const rev = (await entryLines(prisma, o.orderId, "refund"))!;
      const sale = (await entryLines(prisma, o.orderId, "sale"))!;
      expect(rev.sum).toBe(0n);
      expect(Object.fromEntries(Object.entries(rev.byKind).map(([k, v]) => [k, -v]))).toEqual(sale.byKind);
    });

    it("a Razorpay outage leaves it APPROVED for the retry job, which finishes it", async () => {
      testState.failOnPaid = new AppError("ITEM_GONE", 422, "The item was withdrawn");
      const o = await pay();
      const row = (await prisma.outboxEvent.findMany({ where: { type: "order.fulfilment_failed" } })).find((x) => (x.payload as { orderId?: string }).orderId === o.orderId)!;
      const event = { type: "order.fulfilment_failed" as const, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0];
      fake.failNext.set("createRefund", new RazorpayApiError(503, null, "down"));
      await bus.dispatch(event, row.id).catch(() => undefined); // the outbox retries the event; either way the refund row exists
      const stuck = await prisma.refund.findFirstOrThrow({ where: { orderId: o.orderId } });
      expect(stuck.status).toBe("APPROVED");

      t.clock.advance(10 * 60 * 1000);
      const { RefundsProcessor } = await import("../../src/modules/billing/refunds.processor");
      await t.app.get(RefundsProcessor).resumeStuck();
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: "PROCESSING" });
      expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(1);
    });
  });
  describe("recovering refunds Razorpay made that we did not record", () => {
    it("a webhook is matched to our refund by notes.refundId when the Razorpay id was never stored, and the id is adopted", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      await prisma.refund.update({ where: { id: asked.body.id }, data: { status: "APPROVED", decidedBy: "x" } }); // crashed between Razorpay success and storing PROCESSING
      const rid = `rfnd_adopted_${randomUUID().slice(0, 8)}`;
      const row = await sendRefundWebhook("refund.processed", { id: rid, paymentId: o.paymentId, amountPaise: 100000n, notes: { refundId: asked.body.id } });
      await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "PROCESSED", razorpayRefundId: rid });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "REFUNDED" });
    });

    it("notes.refundId is only trusted when the payment matches the refund's order", async () => {
      const o = await pay();
      const other = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      await prisma.refund.update({ where: { id: asked.body.id }, data: { status: "APPROVED", decidedBy: "x" } });
      const processor = t.app.get(WebhookProcessor);
      const row = await sendRefundWebhook("refund.processed", { id: `rfnd_wrong_${randomUUID().slice(0, 8)}`, paymentId: other.paymentId, amountPaise: 100000n, notes: { refundId: asked.body.id } });
      await expect(processor.process({ data: { webhookEventId: row.id } } as Job<{ webhookEventId: string }>)).rejects.toThrow(/unknown refund/i);
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "APPROVED", razorpayRefundId: null });
    });

    it("a refund made from the Razorpay dashboard (no id, no notes) is retried, then raises a finance alert and a Sentry report instead of being dropped quietly", async () => {
      const processor = t.app.get(WebhookProcessor);
      const sentry = jest.spyOn(sentryModule, "reportException").mockImplementation(() => undefined);
      const o = await pay();
      const ghostId = `rfnd_dashboard_${randomUUID().slice(0, 8)}`;
      const row = await sendRefundWebhook("refund.processed", { id: ghostId, paymentId: o.paymentId, amountPaise: 100000n });
      const job = { data: { webhookEventId: row.id } } as Job<{ webhookEventId: string }>;
      await expect(processor.process(job)).rejects.toThrow(/unknown refund/i);
      await processor.onExhausted(job, new Error("unknown refund"));
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt).not.toBeNull();
      const alert = await until(async () =>
        (await prisma.notification.findMany({ where: { userId: { in: financeAdmins }, type: "finance.alert" } })).find(
          (n) => (n.data as { kind?: string; razorpayRefundId?: string } | null)?.kind === "REFUND_UNMATCHED" && (n.data as { razorpayRefundId?: string }).razorpayRefundId === ghostId,
        ),
      );
      expect(alert.body).toContain(ghostId);
      expect((alert.data as { orderId?: string }).orderId).toBe(o.orderId); // found through the payment id
      expect(sentry).toHaveBeenCalled();
      sentry.mockRestore();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ status: "PAID" });
    });

    it("a 4xx from Razorpay on the start call adopts a refund Razorpay already made for this refund id instead of failing it", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      const made = { id: `rfnd_made_${randomUUID().slice(0, 8)}`, paymentId: o.paymentId, amountPaise: 100000n, status: "processed", notes: { refundId: asked.body.id as string } };
      fake.refunds.push(made);
      fake.failNext.set("createRefund", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "The refund amount provided is greater than amount captured"));
      const res = await approve(asked.body.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("PROCESSING");
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "PROCESSING", razorpayRefundId: made.id, failureReason: null });
    });

    it("a 4xx only fails the refund after Razorpay was asked and has none for it; if that lookup itself fails the refund stays APPROVED (502)", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      fake.failNext.set("createRefund", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "nope"));
      fake.failNext.set("listRefunds", new RazorpayApiError(503, null, "down"));
      const down = await approve(asked.body.id);
      expect(down.status).toBe(502);
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "APPROVED" });
      fake.failNext.set("createRefund", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "nope"));
      const failed = await approve(asked.body.id);
      expect(failed.body.status).toBe("FAILED");
      expect(fake.callsTo("listRefunds").length).toBeGreaterThanOrEqual(2);
    });

    it("the call path never flips a refund that is already PROCESSING to FAILED (only the refund.failed webhook does)", async () => {
      const o = await pay();
      const asked = await requestRefund(o.buyer, o.orderId);
      await prisma.refund.update({ where: { id: asked.body.id }, data: { status: "APPROVED", decidedBy: "x" } });
      const spy = jest.spyOn(fake, "createRefund").mockImplementationOnce(async () => {
        // a concurrent start (or the webhook adoption) got there first while this call was in flight
        await prisma.refund.update({ where: { id: asked.body.id }, data: { status: "PROCESSING", razorpayRefundId: "rfnd_concurrent" } });
        throw new RazorpayApiError(400, "BAD_REQUEST_ERROR", "already refunded");
      });
      try {
        await approve(asked.body.id);
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } })).toMatchObject({ status: "PROCESSING", razorpayRefundId: "rfnd_concurrent" });
    });
  });

  describe("GST credit notes", () => {
    const issuer = () => t.app.get(InvoiceIssuer);
    const setClock = (to: Date) => t.clock.advance(to.getTime() - t.clock.now().getTime());
    const dispatchRefunded = async (orderId: string) => {
      const row = (await prisma.outboxEvent.findMany({ where: { type: "order.refunded" } })).find((x) => (x.payload as { orderId?: string }).orderId === orderId)!;
      await bus.dispatch({ type: "order.refunded" as const, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
      return row;
    };
    async function refundedWithEvent(o: Awaited<ReturnType<typeof pay>>) {
      await issuer().issueForOrder(o.orderId);
      const refund = await approvedRefund(o);
      await deliverRefundWebhook("refund.processed", refund.id);
      return { refund, row: await dispatchRefunded(o.orderId) };
    }

    it("order.refunded issues a credit note that mirrors the invoice with negative values, references its number and is stored privately", async () => {
      const o = await pay({ pricePaise: 100000n });
      const { refund, row } = await refundedWithEvent(o);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: o.orderId } });
      const cn = await prisma.creditNote.findUniqueOrThrow({ where: { refundId: refund.id } });
      expect(cn.number).toMatch(/^SKC\/\d{2}-\d{2}\/\d{6}$/);
      expect(cn.number).toHaveLength(16);
      expect(cn).toMatchObject({ invoiceId: inv.id, orderId: o.orderId, buyerUserId: o.buyer.userId, sellerOwnerId: o.seller.userId, totalPaise: -inv.totalPaise, taxPaise: -inv.taxPaise, objectKey: `credit-notes/${cn.id}.pdf` });
      expect(cn.uploadedAt).not.toBeNull();
      const text = (cn.details as { lines: string[] }).lines.join("\n");
      expect(text).toContain("CREDIT NOTE");
      expect(text).toContain(`Against invoice: ${inv.number}`);
      expect(text).toContain("-INR 1000.00");
      // redelivery of the event issues nothing new
      await bus.dispatch({ type: "order.refunded" as const, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
      expect(await prisma.creditNote.count({ where: { orderId: o.orderId } })).toBe(1);

      const buyer = await t.login(o.buyer.email);
      const dl = await http().get(`/v1/credit-notes/${cn.id}/download`).set(auth(buyer));
      expectDeclared(dl, "GET /v1/credit-notes/{id}/download");
      expect(dl.status).toBe(200);
      expect(Buffer.from(await (await fetch(dl.body.url)).arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
      const staff = await finance();
      expect((await http().get(`/v1/credit-notes/${cn.id}/download`).set(auth(staff))).status).toBe(200);
      const stranger = await t.login();
      expect((await http().get(`/v1/credit-notes/${cn.id}/download`).set(auth(stranger))).status).toBe(404);
      const view = await http().get(`/v1/orders/${o.orderId}`).set(auth(buyer));
      expect(view.body.creditNoteId).toBe(cn.id);
    });

    it("also covers an automatically refunded undelivered order (its invoice was issued by the fulfilment_failed handler)", async () => {
      testState.failOnPaid = new AppError("ITEM_GONE", 422, "The item was withdrawn");
      const o = await pay();
      const failedEvent = (await prisma.outboxEvent.findMany({ where: { type: "order.fulfilment_failed" } })).find((x) => (x.payload as { orderId?: string }).orderId === o.orderId)!;
      await bus.dispatch({ type: "order.fulfilment_failed" as const, ...(failedEvent.payload as object) } as Parameters<EventBus["dispatch"]>[0], failedEvent.id);
      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: o.orderId } });
      await deliverRefundWebhook("refund.processed", refund.id);
      expect(await prisma.invoice.count({ where: { orderId: o.orderId } })).toBe(1);
      await dispatchRefunded(o.orderId);
      expect(await prisma.creditNote.count({ where: { refundId: refund.id } })).toBe(1);
    });

    it("numbers credit notes gap-free per financial year in their own series, independent of invoice numbers", async () => {
      setClock(new Date("2041-03-31T18:00:00Z")); // 23:30 IST, FY 40-41
      const a = await pay();
      const b = await pay();
      await refundedWithEvent(a);
      await refundedWithEvent(b);
      const [na, nb] = await Promise.all([prisma.creditNote.findFirstOrThrow({ where: { orderId: a.orderId } }), prisma.creditNote.findFirstOrThrow({ where: { orderId: b.orderId } })]);
      expect([na.number, nb.number]).toEqual(["SKC/40-41/000001", "SKC/40-41/000002"]);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { orderId: a.orderId } })).number).toMatch(/^SKL\/40-41\//);

      setClock(new Date("2041-03-31T18:31:00Z")); // 00:01 IST on 1 April -> FY 41-42
      const c = await pay();
      await refundedWithEvent(c);
      expect((await prisma.creditNote.findFirstOrThrow({ where: { orderId: c.orderId } })).number).toBe("SKC/41-42/000001");
    });
  });

  describe("refund state on my orders", () => {
    it("shows the live refund (id, status, requestedAt) on the order and the order list, and null once it is rejected or when none was asked for", async () => {
      const o = await pay();
      const other = await pay({ buyer: o.buyer });
      const buyer = await t.login(o.buyer.email);

      const before = await http().get(`/v1/orders/${o.orderId}`).set(auth(buyer));
      expectDeclared(before, "GET /v1/orders/{id}");
      expect(before.body.refund).toBeNull();

      const asked = await requestRefund(buyer, o.orderId);
      expect(asked.status).toBe(201);
      const row = await prisma.refund.findFirstOrThrow({ where: { orderId: o.orderId } });
      const shape = { id: row.id, status: "REQUESTED", requestedAt: row.createdAt.toISOString() };

      const one = await http().get(`/v1/orders/${o.orderId}`).set(auth(buyer));
      expectDeclared(one, "GET /v1/orders/{id}");
      expect(one.body.refund).toEqual(shape);

      const list = await http().get("/v1/orders").set(auth(buyer));
      expectDeclared(list, "GET /v1/orders");
      const byId = new Map((list.body.items as { id: string; refund: unknown }[]).map((x) => [x.id, x.refund]));
      expect(byId.get(o.orderId)).toEqual(shape);
      expect(byId.get(other.orderId)).toBeNull();

      expect((await reject(row.id)).status).toBe(200);
      expect((await http().get(`/v1/orders/${o.orderId}`).set(auth(buyer))).body.refund).toBeNull();
      const again = await http().get("/v1/orders").set(auth(buyer));
      expect((again.body.items as { id: string; refund: unknown }[]).find((x) => x.id === o.orderId)!.refund).toBeNull();
    });
  });
});
