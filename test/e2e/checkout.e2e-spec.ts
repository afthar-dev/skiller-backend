import { randomUUID } from "node:crypto";
import request from "supertest";
import { AppError } from "../../src/common/errors/app-error";
import { EventBus } from "../../src/common/outbox/event-bus";
import { IdempotencyCleanup } from "../../src/common/idempotency";
import * as sentry from "../../src/common/observability/sentry";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { CouponsService, EntitlementsService, FakeRazorpayClient, FulfilmentService, OrdersService, RAZORPAY_CLIENT, WebhookDispatcher } from "../../src/modules/billing";
import { RolesService } from "../../src/modules/rbac";
import { LedgerService } from "../../src/modules/wallet";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { givePlan } from "../support/billing";
import { createTestItem, testState, TestItemProvider } from "../support/test-item";
import { checkDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("checkout, coupons and fulfilment", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let coupons: CouponsService;
  let fulfilment: FulfilmentService;
  let orders: OrdersService;
  let ent: EntitlementsService;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  let financeAdmin: Session;

  const checkout = (buyer: Session, body: object, key: string = randomUUID()) => http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", key).send(body);
  const verify = async (buyer: Session, orderId: string, razorpayOrderId: string, paymentId: string, signature?: string) => checkDeclared(await http().post("/v1/checkout/verify").set(auth(buyer)).send({ orderId, razorpayOrderId, razorpayPaymentId: paymentId, signature: signature ?? fake.paymentSignature(razorpayOrderId, paymentId) }), "POST /v1/checkout/verify");

  /** A seller and one of their TEST_ITEMs. */
  async function listing(opts: { pricePaise?: bigint; plan?: string } = {}) {
    const seller = await t.login();
    if (opts.plan) await givePlan(prisma, "USER", seller.userId, opts.plan);
    await ent.invalidate({ ownerType: "USER", ownerId: seller.userId });
    const itemId = createTestItem({ sellerOwnerId: seller.userId, pricePaise: opts.pricePaise ?? 100000n });
    return { seller, itemId };
  }

  /** A new buyer starts a checkout; returns the response body. */
  async function start(itemId: string, couponCode?: string) {
    const buyer = await t.login();
    const res = await checkout(buyer, { itemType: "TEST_ITEM", itemId, ...(couponCode ? { couponCode } : {}) });
    expect(res.status).toBe(201);
    return { buyer, order: res.body as { orderId: string; razorpayOrderId: string; amountPaise: string; currency: string; keyId: string } };
  }

  async function deliver(type: string, paymentEntity: Record<string, unknown>) {
    // a nonce keeps repeated deliveries distinct bodies (the intake also dedupes on the body hash)
    const hook = fake.webhook(type, { payment: { entity: { ...paymentEntity, notes: { nonce: randomUUID() } } } });
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } } });
    await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
  }
  const captured = (p: { id: string; orderId: string | null; amountPaise: bigint }) => ({ id: p.id, order_id: p.orderId, amount: Number(p.amountPaise), status: "captured" });
  const financeAlert = (orderId: string) =>
    until(async () => (await prisma.notification.findMany({ where: { userId: financeAdmin.userId, type: "finance.alert" } })).find((n) => (n.data as { orderId?: string } | null)?.orderId === orderId));

  async function entryOf(orderId: string) {
    const entry = await prisma.journalEntry.findUnique({ where: { refType_refId_description: { refType: "ORDER", refId: orderId, description: "sale" } }, include: { lines: { include: { account: true } } } });
    if (!entry) return null;
    const byKind: Record<string, bigint> = {};
    for (const l of entry.lines) byKind[l.account.kind] = (byKind[l.account.kind] ?? 0n) + l.amountPaise;
    return { entry, byKind, sum: entry.lines.reduce((s, l) => s + l.amountPaise, 0n) };
  }

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    ledger = t.app.get(LedgerService);
    coupons = t.app.get(CouponsService);
    fulfilment = t.app.get(FulfilmentService);
    orders = t.app.get(OrdersService);
    ent = t.app.get(EntitlementsService);
    financeAdmin = await t.login();
    await t.app.get(RolesService).grantSystem(financeAdmin.userId, "finance_admin");
  });
  afterAll(() => t?.close());
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    testState.failOnPaid = null;
    testState.writeMarkerBeforeFail = false;
  });

  describe("POST /v1/checkout", () => {
    it("prices the order on the server: client-sent amounts are ignored and the Razorpay order is for exactly the total", async () => {
      const { itemId } = await listing({ pricePaise: 100000n });
      const buyer = await t.login();
      const res = await checkout(buyer, { itemType: "TEST_ITEM", itemId, amountPaise: "1", pricePaise: 1, amount: 1, totalPaise: "1" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ orderId: expect.any(String), razorpayOrderId: expect.stringMatching(/^order_/), amountPaise: "100000", currency: "INR", keyId: "rzp_test_key" });
      const rzp = fake.orders.get(res.body.razorpayOrderId)!;
      expect(rzp.amountPaise).toBe(100000n);
      expect(rzp.receipt).toBe(res.body.orderId);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId }, include: { items: true } });
      expect(order).toMatchObject({ status: "CREATED", buyerId: buyer.userId, listPricePaise: 100000n, discountPaise: 0n, totalPaise: 100000n, commissionBps: 1000, gstBps: 1800, razorpayOrderId: res.body.razorpayOrderId });
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({ itemType: "TEST_ITEM", itemId, unitPricePaise: 100000n });
    });

    it("snapshots the seller's real plan version and commission (Free = 1000 bps, Pro = 700 bps)", async () => {
      const free = await listing();
      const pro = await listing({ plan: "pro" });
      const a = await start(free.itemId);
      const b = await start(pro.itemId);
      const freeVersion = await prisma.planVersion.findFirstOrThrow({ where: { plan: { key: "free" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const proSub = await prisma.subscription.findFirstOrThrow({ where: { ownerId: pro.seller.userId } });
      const oa = await prisma.order.findUniqueOrThrow({ where: { id: a.order.orderId } });
      const ob = await prisma.order.findUniqueOrThrow({ where: { id: b.order.orderId } });
      expect(oa).toMatchObject({ commissionBps: 1000, planVersionId: freeVersion.id });
      expect(ob).toMatchObject({ commissionBps: 700, planVersionId: proSub.planVersionId });
    });

    it("requires the Idempotency-Key header and authentication", async () => {
      const { itemId } = await listing();
      const buyer = await t.login();
      const missing = await http().post("/v1/checkout").set(auth(buyer)).send({ itemType: "TEST_ITEM", itemId });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((await http().post("/v1/checkout").set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId })).status).toBe(401);
    });

    it("replays the same response for a repeated key (one order, one Razorpay order); a different body with that key is 409", async () => {
      const { itemId } = await listing();
      const other = await listing();
      const buyer = await t.login();
      const key = randomUUID();
      const before = fake.callsTo("createOrder").length;
      const first = await checkout(buyer, { itemType: "TEST_ITEM", itemId }, key);
      const second = await checkout(buyer, { itemType: "TEST_ITEM", itemId }, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(second.body).toEqual(first.body);
      expect(await prisma.order.count({ where: { buyerId: buyer.userId } })).toBe(1);
      expect(fake.callsTo("createOrder").length - before).toBe(1);
      const reused = await checkout(buyer, { itemType: "TEST_ITEM", itemId: other.itemId }, key);
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("refuses self-purchase, unknown types and items, unpurchasable items and items already owned", async () => {
      const { seller, itemId } = await listing();
      const own = await checkout(seller, { itemType: "TEST_ITEM", itemId });
      expect(own.status).toBe(422);
      expect(own.body.error.code).toBe("CHECKOUT_SELF_PURCHASE");

      const buyer = await t.login();
      expect((await checkout(buyer, { itemType: "NOPE", itemId })).body.error.code).toBe("UNKNOWN_ITEM_TYPE");
      expect((await checkout(buyer, { itemType: "TEST_ITEM", itemId: randomUUID() })).status).toBe(404);
      expect((await checkout(buyer, { itemType: "TEST_ITEM" })).status).toBe(400);

      const hidden = createTestItem({ sellerOwnerId: seller.userId, purchasable: false, reason: "Not published yet" });
      const blocked = await checkout(buyer, { itemType: "TEST_ITEM", itemId: hidden });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: "ITEM_NOT_PURCHASABLE", message: "Not published yet" });

      const first = await checkout(buyer, { itemType: "TEST_ITEM", itemId });
      expect((await verify(buyer, first.body.orderId, first.body.razorpayOrderId, fake.capturePayment(first.body.razorpayOrderId).id)).status).toBe(200);
      const again = await checkout(buyer, { itemType: "TEST_ITEM", itemId });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({ code: "ITEM_NOT_PURCHASABLE", message: "You already own this item" });
    });

    it("a member of the seller organization cannot buy the organization item (self-purchase); outsiders can", async () => {
      const owner = await t.login();
      const org = (await http().post("/v1/orgs").set(auth(owner)).send({ name: "Sell Org", slug: `sell-${randomUUID().slice(0, 8)}` })).body as { id: string };
      const itemId = createTestItem({ sellerOwnerType: "ORG", sellerOwnerId: org.id });
      const own = await checkout(owner, { itemType: "TEST_ITEM", itemId });
      expect(own.status).toBe(422);
      expect(own.body.error.code).toBe("CHECKOUT_SELF_PURCHASE");
      const outsider = await t.login();
      expect((await checkout(outsider, { itemType: "TEST_ITEM", itemId })).status).toBe(201);
    });

    it("rejects an item priced below the gateway minimum and a coupon that leaves less than 1 INR", async () => {
      const cheap = await listing({ pricePaise: 50n });
      const buyer = await t.login();
      expect((await checkout(buyer, { itemType: "TEST_ITEM", itemId: cheap.itemId })).body.error.code).toBe("CHECKOUT_PRICE_TOO_LOW");
      const { itemId } = await listing({ pricePaise: 100000n });
      const code = `FLAT${randomUUID().slice(0, 8).toUpperCase()}`;
      await coupons.create({ code, kind: "FLAT", value: 99950n, fundedBy: "PLATFORM", scope: "ALL" });
      expect((await checkout(buyer, { itemType: "TEST_ITEM", itemId, couponCode: code })).body.error.code).toBe("CHECKOUT_TOTAL_TOO_LOW");
    });
  });

  describe("fulfilment", () => {
    it("a 1,000 INR sale at 1000 bps: clearing -100000, seller PENDING +90000, platform revenue +8475, tax payable +1525", async () => {
      const { seller, itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      const res = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ orderId: order.orderId, status: "PAID" });

      const e = (await entryOf(order.orderId))!;
      expect(e.byKind).toEqual({ GATEWAY_CLEARING: -100000n, PENDING: 90000n, PLATFORM_REVENUE: 8475n, TAX_PAYABLE: 1525n });
      expect(e.sum).toBe(0n);
      expect((await ledger.balancesFor("USER", seller.userId)).PENDING).toBe(90000n);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(row).toMatchObject({ status: "PAID", razorpayPaymentId: payment.id });
      expect(row.paidAt).not.toBeNull();
      expect(testState.paid.filter((id) => id === order.orderId)).toHaveLength(1);
      const events = (await prisma.outboxEvent.findMany({ where: { type: "order.paid" } })).filter((x) => (x.payload as { orderId?: string }).orderId === order.orderId);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ buyerId: buyer.userId, sellerOwnerId: seller.userId, totalPaise: "100000", itemType: "TEST_ITEM" });
    });

    it("webhook before verify: one fulfilment, and the later verify answers 200 PAID without posting again", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      await deliver("payment.captured", captured(payment));
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
      const res = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("PAID");
      await deliver("payment.captured", captured(payment)); // a second webhook for the same payment
      expect(await prisma.journalEntry.count({ where: { refType: "ORDER", refId: order.orderId } })).toBe(1);
      expect(testState.paid.filter((id) => id === order.orderId)).toHaveLength(1);
    });

    it("verify racing the webhook still fulfils exactly once", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      const [v1, v2] = await Promise.all([
        verify(buyer, order.orderId, order.razorpayOrderId, payment.id),
        verify(buyer, order.orderId, order.razorpayOrderId, payment.id),
        deliver("payment.captured", captured(payment)),
      ]);
      expect([v1.status, v2.status]).toEqual([200, 200]);
      expect(await prisma.journalEntry.count({ where: { refType: "ORDER", refId: order.orderId } })).toBe(1);
      expect(testState.paid.filter((id) => id === order.orderId)).toHaveLength(1);
      const events = (await prisma.outboxEvent.findMany({ where: { type: "order.paid" } })).filter((x) => (x.payload as { orderId?: string }).orderId === order.orderId);
      expect(events).toHaveLength(1);
    });

    it("a payment of the wrong amount fails the order, posts nothing and alerts finance", async () => {
      const spy = jest.spyOn(sentry, "reportException");
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId, { amountPaise: 50000n });
      const res = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("PAYMENT_AMOUNT_MISMATCH");
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("FAILED");
      expect(await entryOf(order.orderId)).toBeNull();
      expect(testState.paid).not.toContain(order.orderId);
      const alert = await financeAlert(order.orderId);
      expect(alert.data).toMatchObject({ kind: "PAYMENT_AMOUNT_MISMATCH", orderId: order.orderId });
      expect(spy).toHaveBeenCalled();
    });

    it("an authorized (not yet captured) payment is not fulfilled; once captured the same verify succeeds", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId, { status: "authorized", captured: false });
      const first = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ orderId: order.orderId, status: "CREATED" });
      expect(await entryOf(order.orderId)).toBeNull();
      fake.payments.set(payment.id, { ...payment, status: "captured", captured: true });
      const second = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe("PAID");
    });

    it("verify rejects a bad signature, someone else's order and a different Razorpay order id", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      const bad = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id, "0".repeat(64));
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("PAYMENT_SIGNATURE_INVALID");
      const stranger = await t.login();
      expect((await verify(stranger, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(404);
      const wrongOrder = await verify(buyer, order.orderId, "order_other", payment.id, fake.paymentSignature("order_other", payment.id));
      expect(wrongOrder.status).toBe(422);
      expect(wrongOrder.body.error.code).toBe("PAYMENT_ORDER_MISMATCH");
      expect(await entryOf(order.orderId)).toBeNull();
    });

    it("a payment captured for a different Razorpay order cannot fulfil this one", async () => {
      const a = await listing();
      const b = await listing();
      const first = await start(a.itemId);
      const second = await start(b.itemId);
      const payment = fake.capturePayment(second.order.razorpayOrderId);
      const res = await verify(first.buyer, first.order.orderId, first.order.razorpayOrderId, payment.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("PAYMENT_ORDER_MISMATCH");
      expect(await entryOf(first.order.orderId)).toBeNull();
    });

    it("a second captured payment on a PAID order is kept as DUPLICATE_PAYMENT for a manual refund: no second ledger entry, finance alerted", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const first = fake.capturePayment(order.razorpayOrderId);
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, first.id)).status).toBe(200);
      const second = fake.capturePayment(order.razorpayOrderId);
      const res = await verify(buyer, order.orderId, order.razorpayOrderId, second.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("PAID");
      await deliver("payment.captured", captured(second)); // and the webhook for it does not loop
      const dup = await prisma.duplicatePayment.findMany({ where: { orderId: order.orderId } });
      expect(dup).toHaveLength(1);
      expect(dup[0]).toMatchObject({ razorpayPaymentId: second.id, amountPaise: 100000n, resolvedAt: null });
      expect(await prisma.journalEntry.count({ where: { refType: "ORDER", refId: order.orderId } })).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).razorpayPaymentId).toBe(first.id);
      const alert = await financeAlert(order.orderId);
      expect(alert.data).toMatchObject({ kind: "DUPLICATE_PAYMENT" });
    });

    it("payment.failed marks a CREATED order FAILED; a later successful payment on the same Razorpay order still fulfils it", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      await deliver("payment.failed", { id: `pay_${randomUUID().slice(0, 12)}`, order_id: order.razorpayOrderId, amount: 100000, status: "failed" });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("FAILED");
      const payment = fake.capturePayment(order.razorpayOrderId);
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
      expect(await entryOf(order.orderId)).not.toBeNull();
    });

    it("webhooks for payments we do not know (other orders, subscription charges) are acknowledged, never retried forever", async () => {
      await deliver("payment.captured", { id: `pay_${randomUUID().slice(0, 12)}`, order_id: `order_unknown_${randomUUID().slice(0, 8)}`, amount: 100, status: "captured" });
      await deliver("payment.captured", { id: `pay_${randomUUID().slice(0, 12)}`, order_id: null, amount: 100, status: "captured" });
      await deliver("payment.failed", { id: `pay_${randomUUID().slice(0, 12)}`, order_id: `order_unknown_${randomUUID().slice(0, 8)}`, amount: 100, status: "failed" });
    });

    it("if the provider's onPaid fails the whole payment rolls back (order stays CREATED, nothing posted) and a retry succeeds", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      testState.failOnPaid = new Error("enrolment failed");
      const failed = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(failed.status).toBe(500);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("CREATED");
      expect(await entryOf(order.orderId)).toBeNull();
      const events = (await prisma.outboxEvent.findMany({ where: { type: "order.paid" } })).filter((x) => (x.payload as { orderId?: string }).orderId === order.orderId);
      expect(events).toHaveLength(0);
      testState.failOnPaid = null;
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(200);
      expect(await prisma.journalEntry.count({ where: { refType: "ORDER", refId: order.orderId } })).toBe(1);
    });

    it("a permanent (4xx) onPaid failure on a captured payment keeps the order PAID and the sale posted, rolls back the half-done grant, and tells the buyer and finance", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      testState.failOnPaid = new AppError("COURSE_NOT_FOUND", 404, "The course no longer exists");
      testState.writeMarkerBeforeFail = true;
      try {
        await deliver("payment.captured", captured(payment));
      } finally {
        testState.failOnPaid = null;
        testState.writeMarkerBeforeFail = false;
      }
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(row.status).toBe("PAID");
      expect(row.razorpayPaymentId).toBe(payment.id);
      expect(row.fulfilmentFailedAt).not.toBeNull();
      expect(row.fulfilmentError).toContain("COURSE_NOT_FOUND");
      expect((await entryOf(order.orderId))!.byKind).toMatchObject({ GATEWAY_CLEARING: -100000n, PENDING: 90000n });
      expect(testState.paid).not.toContain(order.orderId);
      expect(await prisma.notification.count({ where: { userId: buyer.userId, type: "test.marker" } })).toBe(0);
      const events = await prisma.outboxEvent.findMany({ where: { type: { in: ["order.paid", "order.fulfilment_failed"] } } });
      const mine = events.filter((x) => (x.payload as { orderId?: string }).orderId === order.orderId);
      expect(mine.map((x) => x.type)).toEqual(["order.fulfilment_failed"]);

      const bus = t.app.get(EventBus);
      const event = { type: "order.fulfilment_failed" as const, ...(mine[0].payload as object) } as Parameters<EventBus["dispatch"]>[0];
      await bus.dispatch(event, mine[0].id);
      await bus.dispatch(event, mine[0].id);
      const told = await prisma.notification.findMany({ where: { userId: buyer.userId, type: "order.fulfilment_failed" } });
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain("refund");
      expect((await financeAlert(order.orderId)).data).toMatchObject({ kind: "FULFILMENT_FAILED" });

      // the browser asking afterwards is told the same thing
      const res = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ orderId: order.orderId, status: "PAID", fulfilment: "FAILED" });
    });

    it("verify answers 200 {status PAID, fulfilment FAILED} when the provider refuses permanently", async () => {
      const { itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      testState.failOnPaid = new AppError("ALREADY_ENROLLED", 409, "Already enrolled");
      try {
        const res = await verify(buyer, order.orderId, order.razorpayOrderId, payment.id);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ orderId: order.orderId, status: "PAID", fulfilment: "FAILED" });
      } finally {
        testState.failOnPaid = null;
      }
      expect(await entryOf(order.orderId)).not.toBeNull();
    });

    it("a transient (5xx or unknown) onPaid failure on the webhook path rolls everything back and the retry succeeds", async () => {
      const { itemId } = await listing();
      const { order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      testState.failOnPaid = new Error("database hiccup");
      testState.writeMarkerBeforeFail = true;
      try {
        await expect(fulfilment.fulfil(order.orderId, payment.id, "webhook")).rejects.toThrow("database hiccup");
      } finally {
        testState.failOnPaid = null;
        testState.writeMarkerBeforeFail = false;
      }
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(row).toMatchObject({ status: "CREATED", fulfilmentFailedAt: null });
      expect(await entryOf(order.orderId)).toBeNull();
      expect(await fulfilment.fulfil(order.orderId, payment.id, "webhook")).toMatchObject({ status: "PAID", outcome: "FULFILLED" });
      expect(testState.paid).toContain(order.orderId);
    });

    it("when the payment.captured job exhausts its retries, finance is alerted", async () => {
      const { itemId } = await listing();
      const { order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      await t.app.get(WebhookDispatcher).exhausted(
        { webhookEventId: randomUUID(), provider: "RAZORPAY", eventId: `evt_${randomUUID()}`, type: "payment.captured", payload: { payload: { payment: { entity: captured(payment) } } } },
        new Error("onPaid keeps failing"),
      );
      expect((await financeAlert(order.orderId)).data).toMatchObject({ kind: "FULFILMENT_FAILED" });
    });

    it("FulfilmentService.fulfil is idempotent when called directly", async () => {
      const { itemId } = await listing();
      const { order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      const a = await fulfilment.fulfil(order.orderId, payment.id, "webhook");
      const b = await fulfilment.fulfil(order.orderId, payment.id, "webhook");
      expect(a).toMatchObject({ status: "PAID", outcome: "FULFILLED" });
      expect(b).toMatchObject({ status: "PAID", outcome: "ALREADY_PAID" });
    });
  });

  describe("coupons", () => {
    const newCode = (prefix = "C") => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;

    it("platform-funded 20%: buyer pays 80000, seller still gets 90000, platform revenue absorbs the discount (net -11525); lines sum to zero", async () => {
      const { seller, itemId } = await listing();
      const code = newCode("PLAT");
      await coupons.create({ code, kind: "PERCENT", value: 2000n, fundedBy: "PLATFORM", scope: "ALL" });
      const { buyer, order } = await start(itemId, code.toLowerCase());
      expect(order.amountPaise).toBe("80000");
      expect(fake.orders.get(order.razorpayOrderId)!.amountPaise).toBe(80000n);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(row).toMatchObject({ listPricePaise: 100000n, discountPaise: 20000n, totalPaise: 80000n, couponFundedBy: "PLATFORM" });

      const payment = fake.capturePayment(order.razorpayOrderId);
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(200);
      const e = (await entryOf(order.orderId))!;
      expect(e.byKind).toEqual({ GATEWAY_CLEARING: -80000n, PENDING: 90000n, PLATFORM_REVENUE: 8475n - 20000n, TAX_PAYABLE: 1525n });
      expect(e.byKind.PLATFORM_REVENUE).toBe(-11525n);
      expect(e.sum).toBe(0n);
      expect((await ledger.balancesFor("USER", seller.userId)).PENDING).toBe(90000n);
      expect(await prisma.couponRedemption.count({ where: { orderId: order.orderId, userId: buyer.userId } })).toBe(1);
    });

    it("creator-funded 20% on Pro (700 bps): commission is taken on the discounted price", async () => {
      const { seller, itemId } = await listing({ plan: "pro" });
      const code = newCode("CRE");
      await coupons.create({ code, kind: "PERCENT", value: 2000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: seller.userId, scope: "ITEM", itemType: "TEST_ITEM", itemId });
      const { buyer, order } = await start(itemId, code);
      expect(order.amountPaise).toBe("80000");
      const payment = fake.capturePayment(order.razorpayOrderId);
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(200);
      const e = (await entryOf(order.orderId))!;
      // fee = floor(80000 x 7%) = 5600 -> 4746 + 854 GST; seller 74400
      expect(e.byKind).toEqual({ GATEWAY_CLEARING: -80000n, PENDING: 74400n, PLATFORM_REVENUE: 4746n, TAX_PAYABLE: 854n });
      expect(e.sum).toBe(0n);
    });

    it("a FLAT coupon takes that many paise off", async () => {
      const { itemId } = await listing({ pricePaise: 100000n });
      const code = newCode("FLAT");
      await coupons.create({ code, kind: "FLAT", value: 15000n, fundedBy: "PLATFORM", scope: "ALL" });
      const { order } = await start(itemId, code);
      expect(order.amountPaise).toBe("85000");
    });

    it("creating a creator coupon needs the creator_coupons entitlement, and the coupon stops working at checkout when the plan lapses", async () => {
      const free = await listing();
      await expect(coupons.create({ code: newCode("NOPE"), kind: "PERCENT", value: 1000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: free.seller.userId, scope: "SELLER" })).rejects.toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED" });

      const { seller, itemId } = await listing({ plan: "pro" });
      const code = newCode("LAPSE");
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: seller.userId, scope: "SELLER" });
      expect((await start(itemId, code)).order.amountPaise).toBe("90000");
      await prisma.subscription.updateMany({ where: { ownerId: seller.userId }, data: { status: "EXPIRED" } });
      await ent.invalidate({ ownerType: "USER", ownerId: seller.userId });
      const buyer = await t.login();
      const res = await checkout(buyer, { itemType: "TEST_ITEM", itemId, couponCode: code });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("COUPON_NOT_APPLICABLE");
    });

    it("rejects unknown, inactive, expired and out-of-scope coupons", async () => {
      const { seller, itemId } = await listing({ plan: "pro" });
      const otherSeller = await listing({ plan: "pro" });
      const buyer = await t.login();
      const tryCode = (code: string) => checkout(buyer, { itemType: "TEST_ITEM", itemId, couponCode: code });

      expect((await tryCode(newCode("NONE"))).body.error.code).toBe("COUPON_NOT_FOUND");

      const inactive = newCode("OFF");
      await coupons.create({ code: inactive, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL" });
      await prisma.coupon.update({ where: { code: inactive }, data: { isActive: false } });
      expect((await tryCode(inactive)).body.error.code).toBe("COUPON_INACTIVE");

      const expired = newCode("OLD");
      await coupons.create({ code: expired, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", expiresAt: new Date(t.clock.now().getTime() - 1000) });
      expect((await tryCode(expired)).body.error.code).toBe("COUPON_EXPIRED");

      const foreignSeller = newCode("SEL");
      await coupons.create({ code: foreignSeller, kind: "PERCENT", value: 1000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: otherSeller.seller.userId, scope: "SELLER" });
      const scoped = await tryCode(foreignSeller);
      expect(scoped.status).toBe(422);
      expect(scoped.body.error.code).toBe("COUPON_NOT_APPLICABLE");

      const foreignItem = newCode("ITM");
      await coupons.create({ code: foreignItem, kind: "PERCENT", value: 1000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: seller.userId, scope: "ITEM", itemType: "TEST_ITEM", itemId: otherSeller.itemId });
      expect((await tryCode(foreignItem)).body.error.code).toBe("COUPON_NOT_APPLICABLE");
    });

    it("max_uses is reserved at checkout (RESERVED then REDEEMED on payment); an exhausted coupon is refused up front", async () => {
      const code = newCode("ONCE");
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", maxUses: 1 });
      const a = await listing();
      const first = await start(a.itemId, code);
      expect(await prisma.couponRedemption.findMany({ where: { coupon: { code } } })).toMatchObject([{ status: "RESERVED", orderId: first.order.orderId, userId: first.buyer.userId }]);

      const second = await t.login();
      const refused = await checkout(second, { itemType: "TEST_ITEM", itemId: a.itemId, couponCode: code });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe("COUPON_EXHAUSTED");

      const p1 = fake.capturePayment(first.order.razorpayOrderId);
      expect((await verify(first.buyer, first.order.orderId, first.order.razorpayOrderId, p1.id)).status).toBe(200);
      expect(await prisma.couponRedemption.findMany({ where: { coupon: { code } } })).toMatchObject([{ status: "REDEEMED", orderId: first.order.orderId }]);
    });

    it("max_uses=2 across three buyers: the third is COUPON_EXHAUSTED, even before anyone has paid", async () => {
      const code = newCode("TWO");
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", maxUses: 2 });
      const a = await listing();
      await start(a.itemId, code);
      await start(a.itemId, code);
      const third = await t.login();
      const res = await checkout(third, { itemType: "TEST_ITEM", itemId: a.itemId, couponCode: code });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("COUPON_EXHAUSTED");
    });

    it("ten parallel checkouts by one buyer with a single-use coupon: one succeeds, the rest are COUPON_ALREADY_USED", async () => {
      const code = newCode("PAR");
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL" });
      const a = await listing();
      const buyer = await t.login();
      const results = await Promise.all(Array.from({ length: 10 }, () => checkout(buyer, { itemType: "TEST_ITEM", itemId: a.itemId, couponCode: code })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const others = results.filter((r) => r.status !== 201);
      expect(others).toHaveLength(9);
      expect(others.every((r) => r.status === 409 && r.body.error.code === "COUPON_ALREADY_USED")).toBe(true);
      expect(await prisma.couponRedemption.count({ where: { coupon: { code } } })).toBe(1);
    });

    it("a reservation released by a failed payment is re-redeemed when that order is later paid and there is capacity; over capacity it still fulfils and finance is told", async () => {
      const code = newCode("REDO");
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", maxUses: 1 });
      const a = await listing();
      const first = await start(a.itemId, code);
      await deliver("payment.failed", { id: `pay_${randomUUID().slice(0, 12)}`, order_id: first.order.razorpayOrderId, amount: 90000, status: "failed" });
      expect(await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: first.order.orderId } })).toMatchObject({ status: "RELEASED" });

      // capacity is free again: the paid order takes the use back
      const p1 = fake.capturePayment(first.order.razorpayOrderId);
      expect((await verify(first.buyer, first.order.orderId, first.order.razorpayOrderId, p1.id)).status).toBe(200);
      expect(await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: first.order.orderId } })).toMatchObject({ status: "REDEEMED" });

      // the same again, but another buyer took the freed use meanwhile
      const code2 = newCode("FULL");
      await coupons.create({ code: code2, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", maxUses: 1 });
      const slow = await start(a.itemId, code2);
      await deliver("payment.failed", { id: `pay_${randomUUID().slice(0, 12)}`, order_id: slow.order.razorpayOrderId, amount: 90000, status: "failed" });
      await start(a.itemId, code2); // takes the single use
      const p2 = fake.capturePayment(slow.order.razorpayOrderId);
      expect((await verify(slow.buyer, slow.order.orderId, slow.order.razorpayOrderId, p2.id)).status).toBe(200);
      expect(await entryOf(slow.order.orderId)).not.toBeNull();
      expect((await financeAlert(slow.order.orderId)).data).toMatchObject({ kind: "COUPON_OVER_LIMIT" });
    });

    it("one redemption per user per coupon", async () => {
      const code = newCode("USER");
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL" });
      const a = await listing();
      const b = await listing();
      const { buyer, order } = await start(a.itemId, code);
      const payment = fake.capturePayment(order.razorpayOrderId);
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(200);
      const again = await checkout(buyer, { itemType: "TEST_ITEM", itemId: b.itemId, couponCode: code });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("COUPON_ALREADY_USED");
    });
  });

  describe("orders API", () => {
    it("lists the buyer's own orders newest first and returns one order; other users get 404", async () => {
      const a = await listing({ pricePaise: 25000n });
      const b = await listing({ pricePaise: 35000n });
      const buyer = await t.login();
      const first = (await checkout(buyer, { itemType: "TEST_ITEM", itemId: a.itemId })).body;
      const second = (await checkout(buyer, { itemType: "TEST_ITEM", itemId: b.itemId })).body;
      const list = await http().get("/v1/orders").set(auth(buyer));
      expect(list.status).toBe(200);
      expect(list.body.items.map((o: { id: string }) => o.id)).toEqual([second.orderId, first.orderId]);
      expect(list.body.items[0]).toMatchObject({ status: "CREATED", currency: "INR", totalPaise: "35000", items: [{ itemType: "TEST_ITEM", itemId: b.itemId, title: "Test course", unitPricePaise: "35000" }] });
      const page = await http().get("/v1/orders?limit=1").set(auth(buyer));
      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).toEqual(expect.any(String));

      const one = await http().get(`/v1/orders/${first.orderId}`).set(auth(buyer));
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ id: first.orderId, totalPaise: "25000" });
      const stranger = await t.login();
      expect((await http().get(`/v1/orders/${first.orderId}`).set(auth(stranger))).status).toBe(404);
      expect((await http().get("/v1/orders").set(auth(stranger))).body.items).toHaveLength(0);
      expect((await http().get("/v1/orders")).status).toBe(401);
    });
  });

  describe("order.paid notifications", () => {
    it("sends the buyer an in-app receipt and an email, and the seller a new-sale notification; redelivery adds nothing", async () => {
      const { seller, itemId } = await listing();
      const { buyer, order } = await start(itemId);
      const payment = fake.capturePayment(order.razorpayOrderId);
      expect((await verify(buyer, order.orderId, order.razorpayOrderId, payment.id)).status).toBe(200);
      const outbox = (await prisma.outboxEvent.findMany({ where: { type: "order.paid" } })).find((x) => (x.payload as { orderId?: string }).orderId === order.orderId)!;
      const bus = t.app.get(EventBus);
      const event = { type: "order.paid" as const, ...(outbox.payload as object) } as Parameters<EventBus["dispatch"]>[0];
      await bus.dispatch(event, outbox.id);
      await bus.dispatch(event, outbox.id);

      const receipts = await prisma.notification.findMany({ where: { userId: buyer.userId, type: "order.receipt" } });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ title: "Payment received", link: `/orders/${order.orderId}` });
      const sales = await prisma.notification.findMany({ where: { userId: seller.userId, type: "order.sale" } });
      expect(sales).toHaveLength(1);
      expect(sales[0].body).toContain("Test course");

      const mail = await until(async () => t.mail.sent.find((m) => m.to === buyer.email && m.subject === "Your receipt for Test course"));
      expect(mail.text).toContain("INR 1000.00");
      expect(t.mail.sent.filter((m) => m.to === buyer.email && m.subject === "Your receipt for Test course")).toHaveLength(1);
    });
  });

  describe("maintenance", () => {
    it("purges idempotency records older than 24 hours and keeps newer ones", async () => {
      const userId = randomUUID();
      const old = await prisma.idempotencyRecord.create({ data: { userId, route: "POST /x", key: "old", requestHash: "h", createdAt: new Date(t.clock.now().getTime() - 25 * 3600_000) } });
      const fresh = await prisma.idempotencyRecord.create({ data: { userId, route: "POST /x", key: "fresh", requestHash: "h", createdAt: new Date(t.clock.now().getTime() - 3600_000) } });
      await t.app.get(IdempotencyCleanup).purge();
      expect(await prisma.idempotencyRecord.findUnique({ where: { id: old.id } })).toBeNull();
      expect(await prisma.idempotencyRecord.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    });

    // Last on purpose: it moves the shared fake clock forward a day.
    it("expires CREATED orders older than 24 hours (paid ones stay), and a payment that arrives late still fulfils", async () => {
      const { itemId } = await listing();
      const other = await listing();
      const stale = await start(itemId);
      const paid = await start(other.itemId);
      expect((await verify(paid.buyer, paid.order.orderId, paid.order.razorpayOrderId, fake.capturePayment(paid.order.razorpayOrderId).id)).status).toBe(200);
      t.clock.advance(25 * 3600_000);
      const young = await start(itemId);
      const n = await orders.expireStale();
      expect(n).toBeGreaterThanOrEqual(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: stale.order.orderId } })).status).toBe("EXPIRED");
      expect((await prisma.order.findUniqueOrThrow({ where: { id: paid.order.orderId } })).status).toBe("PAID");
      expect((await prisma.order.findUniqueOrThrow({ where: { id: young.order.orderId } })).status).toBe("CREATED");

      // the buyer paid the Razorpay order after we expired it: the money was taken, so the order is fulfilled
      const late = fake.capturePayment(stale.order.razorpayOrderId);
      const buyerAgain = await t.login(stale.buyer.email); // the first access token is a day old now
      expect((await verify(buyerAgain, stale.order.orderId, stale.order.razorpayOrderId, late.id)).status).toBe(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: stale.order.orderId } })).status).toBe("PAID");
    });

    it("expiry releases a coupon reservation so the buyer can use the coupon again", async () => {
      const code = `EXP${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      await coupons.create({ code, kind: "PERCENT", value: 1000n, fundedBy: "PLATFORM", scope: "ALL", maxUses: 1 });
      const { itemId } = await listing();
      const first = await start(itemId, code);
      t.clock.advance(25 * 3600_000);
      await orders.expireStale();
      expect(await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: first.order.orderId } })).toMatchObject({ status: "RELEASED" });
      const buyerAgain = await t.login(first.buyer.email);
      const again = await checkout(buyerAgain, { itemType: "TEST_ITEM", itemId, couponCode: code });
      expect(again.status).toBe(201);
      expect(again.body.amountPaise).toBe("90000");
    });
  });
});
