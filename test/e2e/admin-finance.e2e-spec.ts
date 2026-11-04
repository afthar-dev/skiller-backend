import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EntitlementsService, FakeRazorpayClient, FakeRazorpayXClient, RAZORPAY_CLIENT, RAZORPAYX_CLIENT, RefundsService } from "../../src/modules/billing";
import { addDays, istDateOf } from "../../src/modules/billing/ist";
import { RolesService } from "../../src/modules/rbac";
import { AccountsService, LedgerService } from "../../src/modules/wallet";
import { createAuthTestApp, type AuthTestApp } from "../support/auth-app";
import { givePlan } from "../support/billing";
import { paidOrder } from "../support/orders";
import { payoutHelpers, randomPan, until, type Session } from "../support/payouts";
import { createTestItem, TestItemProvider } from "../support/test-item";

describe("finance admin: summary, lists, coupons, flags", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let accts: AccountsService;
  let h: ReturnType<typeof payoutHelpers>;
  let admin: Session;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function fund(userId: string, paise: bigint) {
    await prisma.$transaction(async (tx) => {
      const s = await accts.ensureSellerAccounts(tx, "USER", userId);
      const clearing = await accts.platformAccount("GATEWAY_CLEARING", tx);
      await ledger.post(tx, { refType: "TEST_FUND", refId: randomUUID(), description: "fund", lines: [{ accountId: clearing, amountPaise: -paise }, { accountId: s.AVAILABLE, amountPaise: paise }] });
    });
  }

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake).overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    prisma = t.app.get(PrismaService);
    ledger = t.app.get(LedgerService);
    accts = t.app.get(AccountsService);
    h = payoutHelpers(t, prisma, fakeX);
    admin = await t.login();
    await t.app.get(RolesService).grantSystem(admin.userId, "finance_admin");
    await h.stepUp(admin);
  });
  afterAll(() => t?.close());

  describe("summary", () => {
    const range = () => {
      const today = istDateOf(t.clock.now());
      return `from=${addDays(today, -1)}&to=${addDays(today, 1)}`;
    };
    const summary = async () => {
      const res = await http().get(`/v1/admin/finance/summary?${range()}`).set(auth(admin));
      expect(res.status).toBe(200);
      return res.body as Record<string, string | number>;
    };
    const delta = (after: Record<string, string | number>, before: Record<string, string | number>, key: string) => BigInt(after[key]) - BigInt(before[key]);

    it("equals the ledger for a seeded dataset: two sales, a refunded sale, a paid and a pending payout, a paid subscriber", async () => {
      const before = await summary();
      const a = await paidOrder(t, fake, { pricePaise: 100000n });
      const b = await paidOrder(t, fake, { pricePaise: 250000n });
      const c = await paidOrder(t, fake, { pricePaise: 40000n });

      // c: requested, approved, and the Razorpay refund reported processed -> REFUNDED, reversal posted.
      const asked = await http().post(`/v1/orders/${c.orderId}/refund-requests`).set(auth(c.buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Changed my mind" });
      expect(asked.status).toBe(201);
      await http().post(`/v1/admin/refunds/${asked.body.id}/approve`).set(auth(admin)).send({}).expect(200);
      const refund = await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id }, include: { order: true } });
      await t.app.get(RefundsService).onProcessed({ id: refund.razorpayRefundId!, paymentId: refund.order.razorpayPaymentId, refundIdNote: refund.id });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).status).toBe("REFUNDED");

      // a paid payout of 100000 and a pending one of 70000
      const seller = await h.creatorWithAccount();
      await fund(seller.userId, 300000n);
      await h.stepUp(seller);
      const paidPayout = await http().post("/v1/wallet/payouts").set(auth(seller)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "100000" });
      expect(paidPayout.status).toBe(201);
      await http().post(`/v1/admin/payouts/${paidPayout.body.id}/approve`).set(auth(admin)).send({}).expect(200);
      const sent = await until(async () => {
        const p = await prisma.payout.findUniqueOrThrow({ where: { id: paidPayout.body.id } });
        return p.status === "PROCESSING" && p;
      });
      await h.deliverX(fakeX.payoutWebhook("payout.processed", sent.razorpayxPayoutId!));
      expect((await prisma.payout.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("PAID");
      await h.stepUp(seller);
      expect((await http().post("/v1/wallet/payouts").set(auth(seller)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "70000" })).status).toBe(201);

      // a paid subscriber
      const subscriber = await t.login();
      await givePlan(prisma, "USER", subscriber.userId, "pro");

      const after = await summary();

      // Independent figures, straight from the ledger lines of these three orders.
      const lines = await prisma.ledgerLine.findMany({ where: { entry: { refType: "ORDER", refId: { in: [a.orderId, b.orderId, c.orderId] } } }, include: { account: true } });
      const sum = (kind: string) => lines.filter((l) => l.account.kind === kind).reduce((s, l) => s + l.amountPaise, 0n);
      expect(sum("PLATFORM_REVENUE")).toBe(8475n + 21186n); // fee 10% of 1000 and 2500 rupees, GST 18% carved out of it; the refunded sale nets to 0
      expect(sum("TAX_PAYABLE")).toBe(1525n + 3814n);

      expect(delta(after, before, "gmvPaise")).toBe(350000n);
      expect(delta(after, before, "orderCount")).toBe(2n);
      expect(delta(after, before, "platformRevenuePaise")).toBe(sum("PLATFORM_REVENUE"));
      expect(delta(after, before, "taxPayablePaise")).toBe(sum("TAX_PAYABLE") + 0n);
      expect(delta(after, before, "refundsProcessedPaise")).toBe(40000n);
      expect(delta(after, before, "refundCount")).toBe(1n);
      expect(delta(after, before, "payoutsPaidPaise")).toBe(100000n);
      expect(delta(after, before, "payoutsPaidCount")).toBe(1n);
      expect(delta(after, before, "payoutsPendingPaise")).toBe(70000n);
      expect(delta(after, before, "payoutsPendingCount")).toBe(1n);
      expect(delta(after, before, "activePaidSubscribers")).toBe(1n);
      expect(after.currency).toBe("INR");
      // Every amount is a decimal string.
      for (const key of ["gmvPaise", "platformRevenuePaise", "taxPayablePaise", "refundsProcessedPaise", "payoutsPaidPaise", "payoutsPendingPaise"]) expect(after[key]).toMatch(/^-?\d+$/);
    });

    it("needs finance.view and a sane range", async () => {
      const nobody = await t.login();
      expect((await http().get("/v1/admin/finance/summary").set(auth(nobody))).status).toBe(403);
      expect((await http().get("/v1/admin/finance/summary?from=2026-02-30").set(auth(admin))).status).toBe(400);
      expect((await http().get("/v1/admin/finance/summary?from=2026-05-02&to=2026-05-01").set(auth(admin))).status).toBe(400);
      expect((await http().get("/v1/admin/finance/summary?from=2024-01-01&to=2026-01-01").set(auth(admin))).status).toBe(400);
      expect((await http().get("/v1/admin/finance/summary").set(auth(admin))).status).toBe(200);
    });
  });

  describe("lists", () => {
    it("orders: filters by buyer, status, payment id and day range, paginates, and shows both parties", async () => {
      const a = await paidOrder(t, fake);
      const second = await paidOrder(t, fake, { buyer: a.buyer, seller: a.seller });
      const all = await http().get(`/v1/admin/orders?buyerId=${a.buyer.userId}&limit=1`).set(auth(admin));
      expect(all.status).toBe(200);
      expect(all.body.items).toHaveLength(1);
      expect(all.body.items[0]).toMatchObject({ id: second.orderId, status: "PAID", buyerId: a.buyer.userId, sellerOwnerId: a.seller.userId, commissionBps: 1000, totalPaise: "100000" });
      const next = await http().get(`/v1/admin/orders?buyerId=${a.buyer.userId}&limit=1&cursor=${all.body.nextCursor}`).set(auth(admin));
      expect(next.body.items.map((o: { id: string }) => o.id)).toEqual([a.orderId]);
      const byPayment = await http().get(`/v1/admin/orders?razorpayPaymentId=${a.paymentId}`).set(auth(admin));
      expect(byPayment.body.items.map((o: { id: string }) => o.id)).toEqual([a.orderId]);
      expect((await http().get(`/v1/admin/orders?buyerId=${a.buyer.userId}&status=REFUNDED`).set(auth(admin))).body.items).toEqual([]);
      expect((await http().get(`/v1/admin/orders?buyerId=${a.buyer.userId}&from=2020-01-01&to=2020-01-02`).set(auth(admin))).body.items).toEqual([]);
      expect((await http().get("/v1/admin/orders?status=NOPE").set(auth(admin))).status).toBe(400);
      expect((await http().get("/v1/admin/orders").set(auth(a.buyer))).status).toBe(403);
    });

    it("subscriptions, refunds and payouts: filtered and permission-guarded", async () => {
      const owner = await t.login();
      const sub = await givePlan(prisma, "USER", owner.userId, "business");
      const subs = await http().get(`/v1/admin/subscriptions?ownerId=${owner.userId}&status=ACTIVE&planKey=business`).set(auth(admin));
      expect(subs.status).toBe(200);
      expect(subs.body.items).toEqual([expect.objectContaining({ id: sub.id, status: "ACTIVE", plan: expect.objectContaining({ key: "business", pricePaise: "299900", commissionBps: 500 }) })]);
      expect((await http().get(`/v1/admin/subscriptions?ownerId=${owner.userId}&planKey=pro`).set(auth(admin))).body.items).toEqual([]);
      expect((await http().get("/v1/admin/subscriptions").set(auth(owner))).status).toBe(403);

      const o = await paidOrder(t, fake);
      const asked = await http().post(`/v1/orders/${o.orderId}/refund-requests`).set(auth(o.buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Not for me" });
      const refunds = await http().get(`/v1/admin/refunds?orderId=${o.orderId}&status=REQUESTED`).set(auth(admin));
      expect(refunds.body.items.map((r: { id: string }) => r.id)).toEqual([asked.body.id]);
      expect((await http().get(`/v1/admin/refunds?orderId=${o.orderId}&status=PROCESSED`).set(auth(admin))).body.items).toEqual([]);

      const seller = await h.creatorWithAccount();
      await fund(seller.userId, 100000n);
      await h.stepUp(seller);
      const payout = await http().post("/v1/wallet/payouts").set(auth(seller)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "60000" });
      const today = istDateOf(t.clock.now());
      const payouts = await http().get(`/v1/admin/payouts?ownerId=${seller.userId}&from=${today}&to=${today}`).set(auth(admin));
      expect(payouts.body.items.map((p: { id: string }) => p.id)).toEqual([payout.body.id]);
      expect((await http().get(`/v1/admin/payouts?ownerId=${seller.userId}&from=2020-01-01&to=2020-01-02`).set(auth(admin))).body.items).toEqual([]);
    });
  });

  describe("platform coupons", () => {
    const code = () => `PLAT${randomUUID().slice(0, 6).toUpperCase()}`;

    it("create, list, switch off, delete: step-up and billing.coupons.manage required, every change audited", async () => {
      const nobody = await t.login();
      const c = code();
      expect((await http().post("/v1/admin/coupons").set(auth(nobody)).send({ code: c, kind: "PERCENT", value: "1000" })).status).toBe(403);

      const created = await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: c.toLowerCase(), kind: "PERCENT", value: "1000", maxUses: 5, expiresAt: "2031-01-01T00:00:00.000Z" });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: c, kind: "PERCENT", value: "1000", fundedBy: "PLATFORM", scope: "ALL", maxUses: 5, isActive: true, usedCount: 0 });
      expect((await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: c, kind: "FLAT", value: "500" })).status).toBe(409);
      expect((await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: code(), kind: "PERCENT", value: "10001" })).status).toBe(422);
      expect((await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: code(), kind: "FLAT", value: "12.5" })).status).toBe(400);
      expect((await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: code(), kind: "FLAT", value: "500", scope: "ITEM" })).status).toBe(422);
      expect(await prisma.auditLog.count({ where: { action: "coupon.create", targetId: created.body.id, actorId: admin.userId } })).toBe(1);

      const listed = await http().get(`/v1/admin/coupons?code=${c.slice(0, 8)}&active=true`).set(auth(admin));
      expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(created.body.id);

      const off = await http().patch(`/v1/admin/coupons/${created.body.id}`).set(auth(admin)).send({ isActive: false, maxUses: null });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ isActive: false, maxUses: null });
      expect((await http().patch(`/v1/admin/coupons/${created.body.id}`).set(auth(admin)).send({ value: "1" })).status).toBe(400);
      expect((await http().patch(`/v1/admin/coupons/${created.body.id}`).set(auth(admin)).send({})).status).toBe(400);
      expect(await prisma.auditLog.count({ where: { action: "coupon.update", targetId: created.body.id } })).toBe(1);
      expect((await http().get(`/v1/admin/coupons?active=true&code=${c}`).set(auth(admin))).body.items).toEqual([]);

      expect((await http().delete(`/v1/admin/coupons/${created.body.id}`).set(auth(admin))).status).toBe(204);
      expect(await prisma.coupon.count({ where: { id: created.body.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: "coupon.delete", targetId: created.body.id } })).toBe(1);
      expect((await http().delete(`/v1/admin/coupons/${created.body.id}`).set(auth(admin))).status).toBe(404);
    });

    it("a coupon an order was priced with cannot be deleted, only switched off; it needs step-up", async () => {
      const seller = await t.login();
      const buyer = await t.login();
      const itemId = createTestItem({ sellerOwnerId: seller.userId, pricePaise: 100000n });
      const c = code();
      const created = await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: c, kind: "FLAT", value: "10000" });
      expect(created.status).toBe(201);
      const started = await http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId, couponCode: c });
      expect(started.status).toBe(201);
      const used = await http().delete(`/v1/admin/coupons/${created.body.id}`).set(auth(admin));
      expect(used.status).toBe(409);
      expect(used.body.error.code).toBe("COUPON_IN_USE");
      expect((await http().get(`/v1/admin/coupons?code=${c}`).set(auth(admin))).body.items[0]).toMatchObject({ usedCount: 1 });

      const noStepUp = await t.login();
      await t.app.get(RolesService).grantSystem(noStepUp.userId, "finance_admin");
      const denied = await http().post("/v1/admin/coupons").set(auth(noStepUp)).send({ code: code(), kind: "FLAT", value: "100" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("STEP_UP_REQUIRED");
    });
  });

  describe("creator coupons (/v1/coupons/mine)", () => {
    const code = () => `MINE${randomUUID().slice(0, 6).toUpperCase()}`;

    it("only creators on a plan with creator coupons; scoped to their own items; other creators cannot touch them", async () => {
      const plain = await t.login();
      expect((await http().get("/v1/coupons/mine").set(auth(plain))).body.error.code).toBe("CREATOR_REQUIRED");

      const me = await h.creator();
      const free = await http().post("/v1/coupons/mine").set(auth(me)).send({ code: code(), kind: "PERCENT", value: "2000" });
      expect(free.status).toBe(403);
      expect(free.body.error.code).toBe("ENTITLEMENT_LIMIT_REACHED");

      await givePlan(prisma, "USER", me.userId, "pro");
      await t.app.get(EntitlementsService).invalidate({ ownerType: "USER", ownerId: me.userId });
      const c = code();
      const all = await http().post("/v1/coupons/mine").set(auth(me)).send({ code: c, kind: "PERCENT", value: "2000" });
      expect(all.status).toBe(201);
      expect(all.body).toMatchObject({ code: c, fundedBy: "CREATOR", scope: "SELLER", ownerType: "USER", ownerId: me.userId, value: "2000" });

      const mine = createTestItem({ sellerOwnerId: me.userId });
      const theirs = createTestItem({ sellerOwnerId: plain.userId });
      const itemCoupon = await http().post("/v1/coupons/mine").set(auth(me)).send({ code: code(), kind: "FLAT", value: "5000", scope: "ITEM", itemType: "TEST_ITEM", itemId: mine });
      expect(itemCoupon.status).toBe(201);
      expect(itemCoupon.body).toMatchObject({ scope: "ITEM", itemId: mine });
      expect((await http().post("/v1/coupons/mine").set(auth(me)).send({ code: code(), kind: "FLAT", value: "5000", scope: "ITEM", itemType: "TEST_ITEM", itemId: theirs })).status).toBe(422);
      expect((await http().post("/v1/coupons/mine").set(auth(me)).send({ code: code(), kind: "FLAT", value: "5000", scope: "ALL" })).status).toBe(400);
      expect((await http().post("/v1/coupons/mine").set(auth(me)).send({ code: code(), kind: "FLAT", value: "5000", fundedBy: "PLATFORM" })).status).toBe(400);

      const list = await http().get("/v1/coupons/mine").set(auth(me));
      expect(list.body.items.map((x: { id: string }) => x.id).sort()).toEqual([all.body.id, itemCoupon.body.id].sort());

      const other = await h.creator();
      expect((await http().get("/v1/coupons/mine").set(auth(other))).body.items).toEqual([]);
      expect((await http().patch(`/v1/coupons/mine/${all.body.id}`).set(auth(other)).send({ isActive: false })).status).toBe(404);
      expect((await http().delete(`/v1/coupons/mine/${all.body.id}`).set(auth(other))).status).toBe(404);

      expect((await http().patch(`/v1/coupons/mine/${all.body.id}`).set(auth(me)).send({ isActive: false, maxUses: 3 })).body).toMatchObject({ isActive: false, maxUses: 3 });
      expect((await http().delete(`/v1/coupons/mine/${all.body.id}`).set(auth(me))).status).toBe(204);
      // A platform coupon is not theirs to change, even by id.
      const platform = await http().post("/v1/admin/coupons").set(auth(admin)).send({ code: code(), kind: "FLAT", value: "100" });
      expect((await http().patch(`/v1/coupons/mine/${platform.body.id}`).set(auth(me)).send({ isActive: false })).status).toBe(404);
    });

    it("a creator coupon works at checkout for their item and only theirs", async () => {
      const me = await h.creator();
      await givePlan(prisma, "USER", me.userId, "pro");
      await t.app.get(EntitlementsService).invalidate({ ownerType: "USER", ownerId: me.userId });
      const c = code();
      expect((await http().post("/v1/coupons/mine").set(auth(me)).send({ code: c, kind: "PERCENT", value: "5000" })).status).toBe(201);
      const buyer = await t.login();
      const itemId = createTestItem({ sellerOwnerId: me.userId, pricePaise: 100000n });
      const started = await http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId, couponCode: c });
      expect(started.status).toBe(201);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: started.body.orderId } })).toMatchObject({ discountPaise: 50000n, totalPaise: 50000n, couponFundedBy: "CREATOR" });
      const elsewhere = createTestItem({ sellerOwnerId: (await t.login()).userId });
      const other = await t.login();
      const refused = await http().post("/v1/checkout").set(auth(other)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId: elsewhere, couponCode: c });
      expect(refused.status).toBe(422);
    });
  });

  describe("payout account review flags", () => {
    it("clear-flag clears exactly the flag that is set, needs payout.approve and step-up, and is audited", async () => {
      const pan = randomPan();
      const first = await h.creatorWithAccount(h.bankBody({ pan }));
      const second = await h.creatorWithAccount(h.bankBody({ pan }));
      for (const id of [first.accountId, second.accountId]) expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id } })).reviewFlag).toBe("DUPLICATE_PAN");

      const nobody = await t.login();
      expect((await http().post(`/v1/admin/payout-accounts/${first.accountId}/clear-flag`).set(auth(nobody)).send({ flag: "DUPLICATE_PAN" })).status).toBe(403);
      expect((await http().post(`/v1/admin/payout-accounts/${first.accountId}/clear-flag`).set(auth(admin)).send({ flag: "OTHER" })).status).toBe(400);
      expect((await http().post(`/v1/admin/payout-accounts/${first.accountId}/clear-flag`).set(auth(admin)).send({ flag: "NAME_MISMATCH" })).status).toBe(409);

      const cleared = await http().post(`/v1/admin/payout-accounts/${first.accountId}/clear-flag`).set(auth(admin)).send({ flag: "DUPLICATE_PAN", note: "Same person, two profiles; ID checked" });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ id: first.accountId, reviewFlag: null });
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: first.accountId } })).reviewFlag).toBeNull();
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: second.accountId } })).reviewFlag).toBe("DUPLICATE_PAN"); // the other account is reviewed on its own
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "payout_account.clear_flag", targetId: first.accountId } });
      expect(audit).toMatchObject({ actorId: admin.userId });
      expect(JSON.stringify(audit.after)).toContain("Same person, two profiles");
      expect((await http().post(`/v1/admin/payout-accounts/${first.accountId}/clear-flag`).set(auth(admin)).send({ flag: "DUPLICATE_PAN" })).status).toBe(409);
      expect((await http().post(`/v1/admin/payout-accounts/${randomUUID()}/clear-flag`).set(auth(admin)).send({ flag: "DUPLICATE_PAN" })).status).toBe(404);

      const noStepUp = await t.login();
      await t.app.get(RolesService).grantSystem(noStepUp.userId, "finance_admin");
      const denied = await http().post(`/v1/admin/payout-accounts/${second.accountId}/clear-flag`).set(auth(noStepUp)).send({ flag: "DUPLICATE_PAN" });
      expect(denied.body.error.code).toBe("STEP_UP_REQUIRED");
    });
  });
});
