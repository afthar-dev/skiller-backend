import { randomUUID } from "node:crypto";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis/redis.constants";
import {
  FakeRazorpayClient,
  FakeRazorpayXClient,
  HoldReleaseProcessor,
  RAZORPAY_CLIENT,
  RAZORPAYX_CLIENT,
  RazorpayApiError,
  PayoutMaintenanceProcessor,
  PayoutsService,
} from "../../src/modules/billing";
import { RolesService } from "../../src/modules/rbac";
import { AccountsService, LedgerService } from "../../src/modules/wallet";
import { createAuthTestApp, type AuthTestApp } from "../support/auth-app";
import { paidOrder } from "../support/orders";
import { DAY, payoutHelpers, randomPan, until, type Session } from "../support/payouts";
import { testState, TestItemProvider } from "../support/test-item";

describe("payouts", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let accts: AccountsService;
  let bus: EventBus;
  let h: ReturnType<typeof payoutHelpers>;
  let admin: Session;
  let adminAt = 0;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  type Ready = Session & { accountId: string };
  const owner = (s: { userId: string }) => ({ ownerType: "USER" as const, ownerId: s.userId });

  /** The finance admin, re-authenticated (login + step-up) whenever the fake clock has moved on enough to expire the tokens. */
  async function finance(): Promise<Session> {
    if (!admin || t.clock.now().getTime() - adminAt > 3 * 60_000) {
      admin = await t.login();
      await t.app.get(RolesService).grantSystem(admin.userId, "finance_admin");
      await h.stepUp(admin);
      adminAt = t.clock.now().getTime();
    }
    return admin;
  }

  /** Moves money into an owner's AVAILABLE balance (negative: out of it) the way a released sale would. */
  async function fund(o: { ownerType: "USER" | "ORG"; ownerId: string }, paise: bigint) {
    await prisma.$transaction(async (tx) => {
      const seller = await accts.ensureSellerAccounts(tx, o.ownerType, o.ownerId);
      const clearing = await accts.platformAccount("GATEWAY_CLEARING", tx);
      await ledger.post(tx, { refType: "TEST_FUND", refId: randomUUID(), description: "fund", lines: [{ accountId: clearing, amountPaise: -paise }, { accountId: seller.AVAILABLE, amountPaise: paise }] });
    });
  }

  /** A creator whose payout account is verified and past its cooldown, with `paise` available and a fresh step-up. */
  async function ready(paise = 200_000n, body: object = h.bankBody()): Promise<Ready> {
    const s = await h.creatorWithAccount(body);
    await fund(owner(s), paise);
    await h.stepUp(s);
    return s;
  }

  const requestPayout = (s: Session, amountPaise: unknown, key: string = randomUUID()) => http().post("/v1/wallet/payouts").set(auth(s)).set("Idempotency-Key", key).send({ amountPaise });
  // Sessions are resolved BEFORE the request object exists: supertest closes the shared server when any one request ends.
  const approve = async (id: string, who?: Session) => {
    const as = who ?? (await finance());
    return http().post(`/v1/admin/payouts/${id}/approve`).set(auth(as)).send({});
  };
  const reject = async (id: string, note?: string, who?: Session) => {
    const as = who ?? (await finance());
    return http().post(`/v1/admin/payouts/${id}/reject`).set(auth(as)).send(note ? { note } : {});
  };
  const payoutRow = (id: string) => prisma.payout.findUniqueOrThrow({ where: { id } });
  const balances = (s: { userId: string }) => ledger.balancesFor("USER", s.userId);

  /** Waits until the send job has put the payout PROCESSING at RazorpayX and returns the row. */
  const processing = (id: string) => until(async () => (await payoutRow(id)).status === "PROCESSING" && (await payoutRow(id)));

  /** A payout requested, approved and sent to RazorpayX. */
  async function sent(s: Ready, amount = 100_000n) {
    const res = await requestPayout(s, amount.toString());
    expect(res.status).toBe(201);
    expect((await approve(res.body.id)).status).toBe(200);
    return processing(res.body.id as string);
  }

  async function deliver(type: Parameters<FakeRazorpayXClient["payoutWebhook"]>[0], payoutId: string, opts: Parameters<FakeRazorpayXClient["payoutWebhook"]>[2] = {}) {
    const row = await payoutRow(payoutId);
    return h.deliverX(fakeX.payoutWebhook(type, row.razorpayxPayoutId!, opts));
  }

  async function entry(payoutId: string, description: string) {
    const e = await prisma.journalEntry.findUnique({ where: { refType_refId_description: { refType: "PAYOUT", refId: payoutId, description } }, include: { lines: { include: { account: true } } } });
    if (!e) return null;
    const byKind: Record<string, bigint> = {};
    for (const l of e.lines) byKind[l.account.kind] = (byKind[l.account.kind] ?? 0n) + l.amountPaise;
    return { byKind, sum: e.lines.reduce((s, l) => s + l.amountPaise, 0n), count: e.lines.length };
  }

  /** The outbox row of a payout event, replayed through the bus like the relay would. */
  async function replay(type: string, payoutId: string) {
    const row = (await prisma.outboxEvent.findMany({ where: { type } })).find((x) => (x.payload as { payoutId?: string }).payoutId === payoutId);
    if (!row) throw new Error(`no ${type} outbox row for ${payoutId}`);
    await bus.dispatch({ type, ...(row.payload as object) } as Parameters<EventBus["dispatch"]>[0], row.id);
    return row;
  }

  // Settings are global in a shared database: written straight to the table (SettingsService.set leaves audit rows other suites count) and removed after.
  async function withSettings<T>(values: Record<string, number>, run: () => Promise<T>): Promise<T> {
    const redis = t.app.get<import("ioredis").Redis>(REDIS);
    for (const [key, value] of Object.entries(values)) {
      await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      await redis.del(`settings:${key}`);
    }
    try {
      return await run();
    } finally {
      await prisma.platformSetting.deleteMany({ where: { key: { in: Object.keys(values) } } });
      for (const key of Object.keys(values)) await redis.del(`settings:${key}`);
    }
  }

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake).overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    prisma = t.app.get(PrismaService);
    ledger = t.app.get(LedgerService);
    accts = t.app.get(AccountsService);
    bus = t.app.get(EventBus);
    h = payoutHelpers(t, prisma, fakeX);
    await finance();
  });
  afterAll(() => t?.close());
  beforeEach(() => {
    testState.failOnPaid = null;
    testState.writeMarkerBeforeFail = false;
  });

  describe("POST /v1/wallet/payouts", () => {
    it("locks the amount (AVAILABLE -> PAYOUT_LOCKED) in a zero-sum entry, creates a REQUESTED payout, and replays the same response for a repeated key", async () => {
      const s = await ready(200_000n);
      const key = randomUUID();
      const res = await requestPayout(s, "100000", key);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "REQUESTED", amountPaise: "100000", tdsPaise: "0", netPaise: "100000", mode: "IMPS", currency: "INR", ownerType: "USER", ownerId: s.userId });
      expect(await balances(s)).toMatchObject({ AVAILABLE: 100_000n, PAYOUT_LOCKED: 100_000n });
      expect(await entry(res.body.id, "payout_request")).toMatchObject({ byKind: { AVAILABLE: -100_000n, PAYOUT_LOCKED: 100_000n }, sum: 0n });

      const replay = await requestPayout(s, "100000", key);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(res.body.id);
      expect(await prisma.payout.count({ where: { ownerId: s.userId } })).toBe(1);
      expect(await balances(s)).toMatchObject({ AVAILABLE: 100_000n, PAYOUT_LOCKED: 100_000n });
    });

    it("requires an Idempotency-Key, a fresh step-up, a creator and authentication", async () => {
      const s = await ready();
      const missing = await http().post("/v1/wallet/payouts").set(auth(s)).send({ amountPaise: "100000" });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((await http().post("/v1/wallet/payouts").set("Idempotency-Key", randomUUID()).send({ amountPaise: "100000" })).status).toBe(401);

      const plain = await t.login();
      await h.stepUp(plain);
      expect((await requestPayout(plain, "100000")).body.error.code).toBe("CREATOR_REQUIRED");

      const noStepUp = await t.login(s.email);
      const res = await requestPayout(noStepUp, "100000");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.payout.count({ where: { ownerId: s.userId } })).toBe(0);
    });

    it("rejects amounts below the minimum (PAYOUT_BELOW_MINIMUM) and malformed amounts", async () => {
      const s = await ready();
      const low = await requestPayout(s, "49999");
      expect(low.status).toBe(422);
      expect(low.body.error.code).toBe("PAYOUT_BELOW_MINIMUM");
      expect(low.body.error.details).toMatchObject({ minPaise: "50000" });
      expect((await requestPayout(s, "50000")).status).toBe(201);
      for (const bad of ["abc", "-5", "0", "10.5", "010", 100000, null, undefined]) expect((await requestPayout(s, bad)).status).toBe(400);
      expect(await prisma.payout.count({ where: { ownerId: s.userId } })).toBe(1);
    });

    it("cannot spend more than AVAILABLE (INSUFFICIENT_BALANCE) and locks nothing when it refuses", async () => {
      const s = await ready(100_000n);
      const res = await requestPayout(s, "100001");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INSUFFICIENT_BALANCE");
      expect(await balances(s)).toMatchObject({ AVAILABLE: 100_000n, PAYOUT_LOCKED: 0n });
      expect(await prisma.payout.count({ where: { ownerId: s.userId } })).toBe(0);
      expect(await prisma.journalEntry.count({ where: { refType: "PAYOUT", description: "payout_request", lines: { some: { account: { ownerId: s.userId } } } } })).toBe(0);
    });

    it("two concurrent payouts for the full balance: one REQUESTED, the other INSUFFICIENT_BALANCE (Review Focus 2)", async () => {
      const s = await ready(100_000n);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => requestPayout(s, "100000")));
      const codes = results.map((r) => (r.status === 201 ? "OK" : r.body.error.code)).sort();
      expect(codes).toEqual(["INSUFFICIENT_BALANCE", "INSUFFICIENT_BALANCE", "INSUFFICIENT_BALANCE", "INSUFFICIENT_BALANCE", "OK"]);
      expect(await prisma.payout.count({ where: { ownerId: s.userId } })).toBe(1);
      expect(await balances(s)).toMatchObject({ AVAILABLE: 0n, PAYOUT_LOCKED: 100_000n });
    });

    it("needs a verified payout account that is past its 24 hour cooldown", async () => {
      const none = await h.creator();
      await fund(owner(none), 100_000n);
      await h.stepUp(none);
      expect((await requestPayout(none, "50000")).body.error.code).toBe("PAYOUT_ACCOUNT_REQUIRED");

      const s = await h.creator();
      await fund(owner(s), 100_000n);
      await h.stepUp(s);
      const put = await h.putAccount(s, h.bankBody());
      expect((await requestPayout(s, "50000")).body.error.code).toBe("PAYOUT_ACCOUNT_NOT_VERIFIED");
      const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: put.body.id } });
      await h.deliverX(fakeX.validationWebhook(acc.razorpayxFundAccountId, "active"));
      // A first account is payable at once ...
      const first = await requestPayout(s, "50000");
      expect(first.status).toBe(201);
      // ... a replacement is paused for 24 hours.
      const change = await h.putAccount(s, h.bankBody());
      await h.deliverX(fakeX.validationWebhook((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: change.body.id } })).razorpayxFundAccountId, "active"));
      const blocked = await requestPayout(s, "50000");
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe("PAYOUT_ACCOUNT_COOLDOWN");
      t.clock.advance(DAY - 1000); // every token issued before has expired by now
      const later = await t.login(s.email);
      await h.stepUp(later);
      expect((await requestPayout(later, "50000")).body.error.code).toBe("PAYOUT_ACCOUNT_COOLDOWN");
      t.clock.advance(1000);
      expect((await requestPayout(later, "50000")).status).toBe(201);
    });

    it("changing the payout account blocks payouts for 24 hours again", async () => {
      const s = await ready();
      expect((await requestPayout(s, "50000")).status).toBe(201);
      const change = await h.putAccount(s, h.bankBody());
      expect(change.status).toBe(200);
      expect((await requestPayout(s, "50000")).body.error.code).toBe("PAYOUT_ACCOUNT_NOT_VERIFIED");
      const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: change.body.id } });
      await h.deliverX(fakeX.validationWebhook(acc.razorpayxFundAccountId, "active"));
      expect((await requestPayout(s, "50000")).body.error.code).toBe("PAYOUT_ACCOUNT_COOLDOWN");
    });

    it("picks UPI for a UPI account, IMPS up to INR 5,00,000 and NEFT above it", async () => {
      const upi = await ready(200_000n, h.upiBody());
      expect((await requestPayout(upi, "100000")).body.mode).toBe("UPI");

      const big = await ready(120_000_000n);
      expect((await requestPayout(big, "50000000")).body.mode).toBe("IMPS"); // exactly INR 5,00,000
      expect((await requestPayout(big, "50000001")).body.mode).toBe("NEFT");
    });

    it("TDS is worked out when the payout is requested and does not change when the rate does", async () => {
      await withSettings({ tds_bps: 100 }, async () => {
        const s = await ready(200_000n);
        const res = await requestPayout(s, "100000");
        expect(res.body).toMatchObject({ tdsPaise: "1000", tdsBps: 100, netPaise: "99000" });
        const odd = await requestPayout(s, "50099"); // floor(50099 x 1%) = 500
        expect(odd.body).toMatchObject({ tdsPaise: "500", netPaise: "49599" });
        await withSettings({ tds_bps: 500 }, async () => {
          expect((await approve(res.body.id)).status).toBe(200);
          await processing(res.body.id);
          await deliver("payout.processed", res.body.id);
          expect(await entry(res.body.id, "payout_settled")).toMatchObject({ byKind: { PAYOUT_LOCKED: -100_000n, GATEWAY_CLEARING: 99_000n, TAX_PAYABLE: 1_000n }, sum: 0n });
        });
      });
    });

    it("a refund of already released money takes AVAILABLE negative and blocks payouts until it is positive again (Review Focus 3)", async () => {
      const seller = await h.creatorWithAccount();
      await h.stepUp(seller);
      const o = await paidOrder(t, fake, { seller, pricePaise: 100_000n });
      await withSettings({ hold_days: 0 }, () => t.app.get(HoldReleaseProcessor).releaseDue());
      const share = (await balances(seller)).AVAILABLE;
      expect(share).toBe(90_000n);
      expect((await requestPayout(seller, "50000")).status).toBe(201); // 40,000 left, 50,000 locked

      // The buyer's refund is approved and processed after the money was released and partly locked for a payout.
      const asked = await http().post(`/v1/orders/${o.orderId}/refund-requests`).set(auth(o.buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Changed my mind" });
      expect(asked.status).toBe(201);
      const fin = await finance();
      expect((await http().post(`/v1/admin/refunds/${asked.body.id}/approve`).set(auth(fin)).send({})).status).toBe(200);
      const refund = await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id }, include: { order: true } });
      const hook = fake.webhook("refund.processed", { refund: { entity: { id: refund.razorpayRefundId, payment_id: refund.order.razorpayPaymentId, amount: Number(refund.amountPaise), status: "processed", notes: { nonce: randomUUID() } } } });
      let r = http().post("/v1/webhooks/razorpay");
      for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
      expect((await r.send(hook.body)).status).toBe(200);
      await until(async () => (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status === "PROCESSED");

      expect((await balances(seller)).AVAILABLE).toBe(-50_000n);
      const stepped = await t.login(seller.email);
      await h.stepUp(stepped);
      const blocked = await requestPayout(stepped, "50000");
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe("INSUFFICIENT_BALANCE");
      await fund(owner(seller), 50_000n); // exactly back to zero: still nothing to withdraw
      expect((await requestPayout(stepped, "50000")).body.error.code).toBe("INSUFFICIENT_BALANCE");
      await fund(owner(seller), 50_000n);
      expect((await requestPayout(stepped, "50000")).status).toBe(201);

      // The ledger still sums to zero for everything this seller did.
      const lines = await prisma.ledgerLine.findMany({ where: { entry: { OR: [{ refType: "ORDER", refId: o.orderId }, { refType: "PAYOUT", lines: { some: { account: { ownerId: seller.userId } } } }] } } });
      const byEntry = new Map<string, bigint>();
      for (const l of lines) byEntry.set(l.entryId, (byEntry.get(l.entryId) ?? 0n) + l.amountPaise);
      expect([...byEntry.values()].every((sum) => sum === 0n)).toBe(true);
    });
  });

  describe("approval and sending", () => {
    it("approve/reject need payout.approve and a fresh step-up", async () => {
      const s = await ready();
      const res = await requestPayout(s, "100000");
      expect((await approve(res.body.id, s)).status).toBe(403);
      expect((await reject(res.body.id, undefined, s)).status).toBe(403);
      expect((await http().get("/v1/admin/payouts").set(auth(s))).status).toBe(403);

      const staff = await t.login();
      await t.app.get(RolesService).grantSystem(staff.userId, "finance_admin");
      const noStepUp = await approve(res.body.id, staff);
      expect(noStepUp.status).toBe(403);
      expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
      expect((await reject(res.body.id, undefined, staff)).body.error.code).toBe("STEP_UP_REQUIRED");
      expect((await payoutRow(res.body.id)).status).toBe("REQUESTED");
    });

    it("approving sends the NET amount to RazorpayX once (reference id and idempotency key = payout id) and stores PROCESSING; approving again changes nothing", async () => {
      await withSettings({ tds_bps: 100 }, async () => {
        const s = await ready();
        const res = await requestPayout(s, "100000");
        const before = fakeX.callsTo("createPayout").length;
        const fin = await finance();
        const [a, b] = await Promise.all([approve(res.body.id, fin), approve(res.body.id, fin)]);
        expect([a.status, b.status]).toEqual([200, 200]);
        const row = await processing(res.body.id);
        expect((await approve(res.body.id)).status).toBe(200);
        expect((await approve(res.body.id, await finance())).body.status).toBe("PROCESSING");

        const calls = fakeX.callsTo("createPayout").slice(before);
        expect(calls).toHaveLength(1);
        const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: s.accountId } });
        expect(calls[0].args[0]).toMatchObject({ fundAccountId: acc.razorpayxFundAccountId, amountPaise: 99_000n, mode: "IMPS", referenceId: res.body.id, idempotencyKey: res.body.id });
        expect(row.razorpayxPayoutId).toBeTruthy();
        expect(row.approvedBy).toBe((await finance()).userId);
        expect(await prisma.auditLog.count({ where: { action: "payout.approve", targetId: res.body.id } })).toBe(1);
        expect(await prisma.outboxEvent.count({ where: { type: "payout.approved", payload: { path: ["payoutId"], equals: res.body.id } } })).toBe(1);
      });
    });

    it("reject returns the funds to AVAILABLE with a reversing entry, is audited, and a decided payout cannot be decided again", async () => {
      const s = await ready(200_000n);
      const res = await requestPayout(s, "100000");
      expect(await balances(s)).toMatchObject({ AVAILABLE: 100_000n, PAYOUT_LOCKED: 100_000n });
      const before = fakeX.callsTo("createPayout").length;
      const rej = await reject(res.body.id, "Details do not match");
      expect(rej.status).toBe(200);
      expect(rej.body).toMatchObject({ status: "REJECTED", failureReason: "Details do not match" });
      expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
      expect(await entry(res.body.id, "payout_reject")).toMatchObject({ byKind: { PAYOUT_LOCKED: -100_000n, AVAILABLE: 100_000n }, sum: 0n });
      expect(await prisma.auditLog.count({ where: { action: "payout.reject", targetId: res.body.id } })).toBe(1);

      expect((await reject(res.body.id)).body.error.code).toBe("PAYOUT_NOT_PENDING");
      expect((await approve(res.body.id)).body.error.code).toBe("PAYOUT_NOT_PENDING");
      expect(fakeX.callsTo("createPayout").length).toBe(before);
      expect((await approve(randomUUID())).status).toBe(404);

      await replay("payout.rejected", res.body.id);
      const note = await prisma.notification.findFirst({ where: { userId: s.userId, type: "payout.rejected" } });
      expect(note?.body).toContain("Details do not match");
      // The released money can be asked for again.
      expect((await requestPayout(s, "200000")).status).toBe(201);
    });

    it("a lost response after RazorpayX accepted the payout is recovered by the retry (found by reference id), never paying twice", async () => {
      const s = await ready();
      const res = await requestPayout(s, "100000");
      fakeX.loseNextPayoutResponse = true;
      expect((await approve(res.body.id)).status).toBe(200);
      const row = await processing(res.body.id);
      expect([...fakeX.payouts.values()].filter((p) => p.referenceId === res.body.id)).toHaveLength(1);
      expect(fakeX.payouts.get(row.razorpayxPayoutId!)?.referenceId).toBe(res.body.id);
    });

    it("the maintenance job re-drives an APPROVED payout nobody sent after 5 minutes, adopting a payout RazorpayX already has", async () => {
      const maintenance = t.app.get(PayoutMaintenanceProcessor);
      const s = await ready(300_000n);
      const fresh = await requestPayout(s, "100000");
      const adopted = await requestPayout(s, "100000");
      for (const id of [fresh.body.id, adopted.body.id]) await prisma.payout.update({ where: { id }, data: { status: "APPROVED", approvedBy: (await finance()).userId, approvedAt: t.clock.now() } });
      // The second one reached RazorpayX before the process died.
      const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: s.accountId } });
      const remote = await fakeX.createPayout({ fundAccountId: acc.razorpayxFundAccountId, amountPaise: 100_000n, mode: "IMPS", referenceId: adopted.body.id, idempotencyKey: adopted.body.id });

      expect(await maintenance.redrive()).toBe(0); // too young
      t.clock.advance(5 * 60_000 + 1000);
      const createsBefore = fakeX.callsTo("createPayout").length;
      expect(await maintenance.redrive()).toBe(2);
      expect(await payoutRow(adopted.body.id)).toMatchObject({ status: "PROCESSING", razorpayxPayoutId: remote.id });
      expect((await payoutRow(fresh.body.id)).status).toBe("PROCESSING");
      expect(fakeX.callsTo("createPayout").length - createsBefore).toBe(1); // only the fresh one was created
      expect(await maintenance.redrive()).toBe(0);
    });

    it("a definitive refusal from RazorpayX fails the payout, returns the funds and tells finance and the creator", async () => {
      const s = await ready();
      const res = await requestPayout(s, "100000");
      fakeX.failNext.set("createPayout", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "The beneficiary account is blocked"));
      expect((await approve(res.body.id)).status).toBe(200);
      const row = await until(async () => (await payoutRow(res.body.id)).status === "FAILED" && (await payoutRow(res.body.id)));
      expect(row.failureReason).toBe("INVALID_ACCOUNT"); // a code, never the provider's text
      expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
      expect(await entry(res.body.id, "payout_failed")).toMatchObject({ byKind: { PAYOUT_LOCKED: -100_000n, AVAILABLE: 100_000n }, sum: 0n });
      const fin = await finance();
      expect(await until(() => prisma.notification.findFirst({ where: { userId: fin.userId, type: "finance.alert", sourceEventId: `finance:payout-failed:${res.body.id}` } }))).toBeTruthy();
      await replay("payout.failed", res.body.id);
      expect(await prisma.notification.count({ where: { userId: s.userId, type: "payout.failed" } })).toBe(1);
    });
  });

  describe("RazorpayX webhooks", () => {
    it("payout.processed settles: PAYOUT_LOCKED -amount / GATEWAY_CLEARING +(amount - tds) / TAX_PAYABLE +tds (1% of INR 1,000 = 1000 paise), once, with outbox event and notification", async () => {
      await withSettings({ tds_bps: 100 }, async () => {
        const s = await ready();
        const p = await sent(s, 100_000n);
        const hook = fakeX.payoutWebhook("payout.processed", p.razorpayxPayoutId!, { utr: "UTR123456789" });
        await h.deliverX(hook);
        const paid = await payoutRow(p.id);
        expect(paid).toMatchObject({ status: "PAID", utr: "UTR123456789" });
        expect(paid.paidAt).not.toBeNull();
        expect(await entry(p.id, "payout_settled")).toMatchObject({ byKind: { PAYOUT_LOCKED: -100_000n, GATEWAY_CLEARING: 99_000n, TAX_PAYABLE: 1_000n }, sum: 0n });
        expect(await balances(s)).toMatchObject({ AVAILABLE: 100_000n, PAYOUT_LOCKED: 0n });

        // The same event again, and another event for the same fact: still one entry.
        const again = await http().post("/v1/webhooks/razorpayx").set(hook.headers).send(hook.body);
        expect(again.status).toBe(200);
        await deliver("payout.processed", p.id, { utr: "UTR-OTHER" });
        expect(await prisma.journalEntry.count({ where: { refType: "PAYOUT", refId: p.id, description: "payout_settled" } })).toBe(1);
        expect((await payoutRow(p.id)).utr).toBe("UTR123456789");
        expect(await prisma.outboxEvent.count({ where: { type: "payout.settled", payload: { path: ["payoutId"], equals: p.id } } })).toBe(1);

        await replay("payout.settled", p.id);
        const note = await prisma.notification.findFirst({ where: { userId: s.userId, type: "payout.paid" } });
        expect(note?.body).toContain("INR 990.00");
        expect(note?.body).toContain("INR 10.00");
      });
    });

    it("with no TDS the settlement has two lines", async () => {
      const s = await ready();
      const p = await sent(s, 100_000n);
      await deliver("payout.processed", p.id);
      const e = await entry(p.id, "payout_settled");
      expect(e).toMatchObject({ byKind: { PAYOUT_LOCKED: -100_000n, GATEWAY_CLEARING: 100_000n }, sum: 0n, count: 2 });
    });

    it("payout.reversed after payout.processed returns the money to AVAILABLE (entry payout_reversed) and undoes the settlement, once", async () => {
      await withSettings({ tds_bps: 100 }, async () => {
        const s = await ready(200_000n);
        const p = await sent(s, 100_000n);
        await deliver("payout.processed", p.id);
        await deliver("payout.reversed", p.id, { failureReason: "Account closed" });
        const row = await payoutRow(p.id);
        expect(row).toMatchObject({ status: "REVERSED", failureReason: "INVALID_ACCOUNT" });
        expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
        expect(await entry(p.id, "payout_reversed")).toMatchObject({ byKind: { GATEWAY_CLEARING: -99_000n, TAX_PAYABLE: -1_000n, AVAILABLE: 100_000n }, sum: 0n });
        await deliver("payout.reversed", p.id, { failureReason: "Account closed (again)" });
        expect(await prisma.journalEntry.count({ where: { refType: "PAYOUT", refId: p.id, description: "payout_reversed" } })).toBe(1);
        // A processed event arriving late cannot bring a reversed payout back.
        await deliver("payout.processed", p.id);
        expect((await payoutRow(p.id)).status).toBe("REVERSED");
        expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });

        await replay("payout.failed", p.id);
        const note = await prisma.notification.findFirst({ where: { userId: s.userId, type: "payout.failed" } });
        expect(note?.title).toBe("Payout returned");
        const fin = await finance();
        expect(await until(() => prisma.notification.findFirst({ where: { userId: fin.userId, type: "finance.alert", sourceEventId: `finance:payout-failed:${p.id}` } }))).toBeTruthy();
      });
    });

    it.each(["payout.failed", "payout.rejected", "payout.reversed"] as const)("%s before settlement unlocks the funds and ends the payout (FAILED / REVERSED), ignoring a late processed", async (type) => {
      const s = await ready(200_000n);
      const p = await sent(s, 100_000n);
      expect(await balances(s)).toMatchObject({ AVAILABLE: 100_000n, PAYOUT_LOCKED: 100_000n });
      await deliver(type, p.id);
      expect((await payoutRow(p.id)).status).toBe(type === "payout.reversed" ? "REVERSED" : "FAILED");
      expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
      await deliver("payout.processed", p.id);
      expect(await entry(p.id, "payout_settled")).toBeNull();
      expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
    });

    it("a payout.processed that arrives before the send was recorded is matched by reference id and settles", async () => {
      const s = await ready();
      const res = await requestPayout(s, "100000");
      // RazorpayX has the payout but our row never got the id (APPROVED, no razorpayxPayoutId).
      const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: s.accountId } });
      const remote = await fakeX.createPayout({ fundAccountId: acc.razorpayxFundAccountId, amountPaise: 100_000n, mode: "IMPS", referenceId: res.body.id, idempotencyKey: res.body.id });
      await prisma.payout.update({ where: { id: res.body.id }, data: { status: "APPROVED", approvedBy: (await finance()).userId, approvedAt: t.clock.now() } });
      await h.deliverX(fakeX.payoutWebhook("payout.processed", remote.id));
      expect(await payoutRow(res.body.id)).toMatchObject({ status: "PAID", razorpayxPayoutId: remote.id });
      expect(await entry(res.body.id, "payout_settled")).toMatchObject({ sum: 0n });
    });

    it("an event for a payout we do not know is stored and retried, never a 500", async () => {
      const unknown = fakeX.unknownPayoutWebhook("payout.processed", { id: `pout_${randomUUID().slice(0, 12)}`, amountPaise: 100_000n });
      let r = http().post("/v1/webhooks/razorpayx");
      for (const [k, v] of Object.entries(unknown.headers)) r = r.set(k, v);
      expect((await r.send(unknown.body)).status).toBe(200);
      const stored = await until(async () => {
        const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAYX", eventId: unknown.headers["x-razorpay-event-id"] } } });
        return row.attempts >= 1 && row.lastError ? row : null;
      });
      expect(stored.processedAt).toBeNull();
      expect(stored.lastError).toMatch(/unknown payout/);

    }, 60_000);
  });

  describe("wallet reads", () => {
    it("GET /v1/wallet/me, /ledger and /payouts show balances as strings, lifetime totals, the owner's own lines (paginated) and payouts", async () => {
      const seller = await h.creatorWithAccount();
      await h.stepUp(seller);
      await paidOrder(t, fake, { seller, pricePaise: 200_000n });
      await withSettings({ hold_days: 0 }, () => t.app.get(HoldReleaseProcessor).releaseDue());
      const me0 = await http().get("/v1/wallet/me").set(auth(seller));
      expect(me0.status).toBe(200);
      expect(me0.body).toMatchObject({ currency: "INR", balances: { available: "180000", pending: "0", payoutLocked: "0" }, lifetimeEarnedPaise: "180000", lifetimeWithdrawnPaise: "0", minPayoutPaise: "50000" });

      const stepped = await t.login(seller.email);
      await h.stepUp(stepped);
      const res = await requestPayout(stepped, "100000");
      expect(res.status).toBe(201);
      await approve(res.body.id);
      const row = await processing(res.body.id);
      await deliver("payout.processed", row.id);
      const me = await http().get("/v1/wallet/me").set(auth(stepped));
      expect(me.body).toMatchObject({ balances: { available: "80000", pending: "0", payoutLocked: "0" }, lifetimeEarnedPaise: "180000", lifetimeWithdrawnPaise: "100000" });

      const page1 = await http().get("/v1/wallet/ledger?limit=2").set(auth(stepped));
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toBeTruthy();
      const page2 = await http().get(`/v1/wallet/ledger?limit=100&cursor=${page1.body.nextCursor}`).set(auth(stepped));
      const all = [...page1.body.items, ...page2.body.items] as { id: string; kind: string; amountPaise: string; refType: string; refId: string; description: string }[];
      expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
      expect(all[0]).toMatchObject({ refType: "PAYOUT", refId: row.id, description: "payout_settled", kind: "PAYOUT_LOCKED", amountPaise: "-100000" });
      expect(all.map((l) => `${l.refType}:${l.description}:${l.kind}:${l.amountPaise}`)).toEqual(
        expect.arrayContaining(["ORDER:sale:PENDING:180000", "ORDER:hold_release:PENDING:-180000", "ORDER:hold_release:AVAILABLE:180000", "PAYOUT:payout_request:AVAILABLE:-100000", "PAYOUT:payout_request:PAYOUT_LOCKED:100000"]),
      );

      const list = await http().get("/v1/wallet/payouts").set(auth(stepped));
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: row.id, status: "PAID", amountPaise: "100000", netPaise: "100000" });
      const plain = await t.login();
      for (const path of ["me", "ledger", "payouts"]) expect((await http().get(`/v1/wallet/${path}`).set(auth(plain))).status).toBe(403);
    });

    it("admin lists payouts by status and owner with wallet.view_any only", async () => {
      const s = await ready();
      const res = await requestPayout(s, "100000");
      const fin = await finance();
      const listed = await http().get(`/v1/admin/payouts?status=REQUESTED&ownerType=USER&ownerId=${s.userId}`).set(auth(fin));
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((x: { id: string }) => x.id)).toEqual([res.body.id]);
      expect((await http().get(`/v1/admin/payouts?ownerId=${s.userId}&status=PAID`).set(auth(fin))).body.items).toEqual([]);
      expect((await http().get(`/v1/admin/payouts/${res.body.id}`).set(auth(fin))).body.id).toBe(res.body.id);
      expect((await http().get(`/v1/admin/payouts/${res.body.id}`).set(auth(s))).status).toBe(403);
    });

    it("an organization's owner runs the payout through the org routes", async () => {
      const ownerS = await t.login();
      const org = (await http().post("/v1/orgs").set(auth(ownerS)).send({ name: "Payout Org", slug: `pw-${h.uid()}` })).body as { id: string; slug: string };
      await h.stepUp(ownerS);
      const put = await http().put(`/v1/orgs/${org.slug}/wallet/payout-account`).set(auth(ownerS)).send(h.bankBody({ pan: randomPan() }));
      expect(put.status).toBe(200);
      const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: put.body.id } });
      await h.deliverX(fakeX.validationWebhook(acc.razorpayxFundAccountId, "active"));
      await fund({ ownerType: "ORG", ownerId: org.id }, 150_000n);
      t.clock.advance(DAY + 1000);
      const again = await t.login(ownerS.email);
      await h.stepUp(again);

      const stranger = await t.login();
      await h.stepUp(stranger);
      expect((await http().post(`/v1/orgs/${org.slug}/wallet/payouts`).set(auth(stranger)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "100000" })).status).toBe(403);
      const me = await http().get(`/v1/orgs/${org.slug}/wallet/me`).set(auth(again));
      expect(me.body.balances.available).toBe("150000");
      const res = await http().post(`/v1/orgs/${org.slug}/wallet/payouts`).set(auth(again)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "100000" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ ownerType: "ORG", ownerId: org.id, requestedBy: again.userId });
      expect((await approve(res.body.id)).status).toBe(200);
      const row = await processing(res.body.id);
      await deliver("payout.processed", row.id);
      expect((await payoutRow(row.id)).status).toBe("PAID");
      expect((await http().get(`/v1/orgs/${org.slug}/wallet/payouts`).set(auth(again))).body.items.map((x: { id: string }) => x.id)).toEqual([row.id]);
      expect((await ledger.balancesFor("ORG", org.id)).AVAILABLE).toBe(50_000n);
    });
  });


  describe("safeguards", () => {
    const createCalls = () => fakeX.callsTo("createPayout").length;

    it("a payout whose account was swapped between request and approval is rejected (PAYOUT_ACCOUNT_CHANGED) and the funds unlock", async () => {
      const s = await ready(200_000n);
      const res = await requestPayout(s, "100000");
      expect((await h.putAccount(s, h.bankBody())).status).toBe(200);
      const before = createCalls();
      const approved = await approve(res.body.id);
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: "REJECTED", failureReason: "PAYOUT_ACCOUNT_CHANGED" });
      expect(approved.body.destination).toMatchObject({ status: "INACTIVE" });
      expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
      expect(await entry(res.body.id, "payout_reject")).toMatchObject({ byKind: { PAYOUT_LOCKED: -100_000n, AVAILABLE: 100_000n }, sum: 0n });
      expect(createCalls()).toBe(before);
      expect(await prisma.auditLog.count({ where: { action: "payout.auto_reject", targetId: res.body.id } })).toBe(1);
      await replay("payout.rejected", res.body.id);
      const note = await prisma.notification.findFirst({ where: { userId: s.userId, type: "payout.rejected" } });
      expect(note?.body).toContain("request it again");
    });

    it("an account held for review (DUPLICATE_PAN / NAME_MISMATCH) or still in cooldown blocks the approval the same way", async () => {
      for (const patch of [{ reviewFlag: "DUPLICATE_PAN" }, { reviewFlag: "NAME_MISMATCH" }, { cooldownUntil: new Date(Date.now() + 3 * DAY) }]) {
        const s = await ready(200_000n);
        const res = await requestPayout(s, "100000");
        await prisma.payoutAccount.update({ where: { id: s.accountId }, data: patch });
        const approved = await approve(res.body.id);
        expect(approved.body).toMatchObject({ status: "REJECTED", failureReason: "PAYOUT_ACCOUNT_CHANGED" });
        expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
      }
    });

    it("the send re-checks the account too: an APPROVED payout whose account was replaced is rejected and unlocked, not sent", async () => {
      const s = await ready(200_000n);
      const res = await requestPayout(s, "100000");
      await prisma.payout.update({ where: { id: res.body.id }, data: { status: "APPROVED", approvedBy: (await finance()).userId, approvedAt: new Date(t.clock.now().getTime() - 6 * 60_000) } });
      expect((await h.putAccount(s, h.bankBody())).status).toBe(200);
      const before = createCalls();
      expect(await t.app.get(PayoutMaintenanceProcessor).redrive()).toBe(0);
      expect(await payoutRow(res.body.id)).toMatchObject({ status: "REJECTED", failureReason: "PAYOUT_ACCOUNT_CHANGED" });
      expect(await balances(s)).toMatchObject({ AVAILABLE: 200_000n, PAYOUT_LOCKED: 0n });
      expect(createCalls()).toBe(before);
    });

    it("finance sees the masked destination and its status and review flag; the creator's view has no review flag", async () => {
      const s = await ready(200_000n, h.upiBody("asha.rao@okhdfc"));
      const res = await requestPayout(s, "100000");
      expect(res.body.destination).toEqual({ type: "UPI", ifsc: null, accountLast4: null, vpaMasked: "as***@okhdfc", status: "VERIFIED" });
      const fin = await finance();
      const one = await http().get(`/v1/admin/payouts/${res.body.id}`).set(auth(fin));
      expect(one.body.destination).toEqual({ type: "UPI", ifsc: null, accountLast4: null, vpaMasked: "as***@okhdfc", status: "VERIFIED", reviewFlag: null });
      const listed = await http().get(`/v1/admin/payouts?ownerId=${s.userId}`).set(auth(fin));
      expect(listed.body.items[0].destination.reviewFlag).toBeNull();
      expect(JSON.stringify(one.body)).not.toContain("asha.rao@");
      const mine = await http().get("/v1/wallet/payouts").set(auth(s));
      expect(mine.body.items[0].destination).not.toHaveProperty("reviewFlag");
    });

    it("the requester cannot approve their own payout (PAYOUT_SELF_APPROVAL)", async () => {
      const s = await ready(200_000n);
      const res = await requestPayout(s, "100000");
      const fin = await finance();
      await prisma.payout.update({ where: { id: res.body.id }, data: { requestedBy: fin.userId } });
      const before = createCalls();
      const denied = await approve(res.body.id, fin);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("PAYOUT_SELF_APPROVAL");
      expect((await payoutRow(res.body.id)).status).toBe("REQUESTED");
      expect(createCalls()).toBe(before);
    });

    it("a UPI payout above the UPI limit is refused at request time (PAYOUT_ABOVE_UPI_LIMIT); the limit itself is allowed", async () => {
      const s = await ready(30_000_000n, h.upiBody());
      const over = await requestPayout(s, "10000001");
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe("PAYOUT_ABOVE_UPI_LIMIT");
      expect((await requestPayout(s, "10000000")).status).toBe(201);
      expect(await balances(s)).toMatchObject({ AVAILABLE: 20_000_000n, PAYOUT_LOCKED: 10_000_000n });
      await withSettings({ upi_max_payout_paise: 60_000 }, async () => {
        expect((await requestPayout(s, "60001")).body.error.code).toBe("PAYOUT_ABOVE_UPI_LIMIT");
        expect((await requestPayout(s, "60000")).status).toBe(201);
      });
    });

    it("provider error text is stored and shown as a code (BANK_REJECTED / INVALID_ACCOUNT / PROVIDER_ERROR); the raw text goes only to finance", async () => {
      const s = await ready(200_000n);
      const res = await requestPayout(s, "100000");
      fakeX.failNext.set("createPayout", new RazorpayApiError(400, "BAD_REQUEST_ERROR", "Insufficient funds in RazorpayX account 2323230000000001, ref ABC-999"));
      expect((await approve(res.body.id)).status).toBe(200);
      const row = await until(async () => (await payoutRow(res.body.id)).status === "FAILED" && (await payoutRow(res.body.id)));
      expect(row.failureReason).toBe("PROVIDER_ERROR");
      await replay("payout.failed", res.body.id);
      const note = await prisma.notification.findFirstOrThrow({ where: { userId: s.userId, type: "payout.failed" } });
      for (const leak of ["Insufficient", "2323230000000001", "ABC-999"]) expect(note.body).not.toContain(leak);
      const fin = await finance();
      const alert = await until(() => prisma.notification.findFirst({ where: { userId: fin.userId, type: "finance.alert", sourceEventId: `finance:payout-failed:${res.body.id}` } }));
      expect(alert.body).toContain("Insufficient funds");

      // The same for a failure the webhook reports.
      const p = await sent(s, 100_000n);
      await deliver("payout.failed", p.id, { failureReason: "Beneficiary bank rejected the payment (code 51)" });
      expect((await payoutRow(p.id)).failureReason).toBe("BANK_REJECTED");
      const p2 = await sent(s, 50_000n);
      await deliver("payout.failed", p2.id, { failureReason: "Beneficiary account is closed" });
      expect((await payoutRow(p2.id)).failureReason).toBe("INVALID_ACCOUNT");
    });

    it("a payout.* or fund_account.validation.* event signed with the Razorpay webhook secret on /webhooks/razorpay changes nothing", async () => {
      const s = await ready();
      const p = await sent(s, 100_000n);
      const forged = fake.webhook("payout.processed", { payout: { entity: { id: p.razorpayxPayoutId, reference_id: p.id, amount: 100000, status: "processed", utr: "FORGED" } } });
      const pending = await h.putAccount(s, h.bankBody());
      const acc = await prisma.payoutAccount.findUniqueOrThrow({ where: { id: pending.body.id } });
      const forgedValidation = fake.webhook("fund_account.validation.completed", { "fund_account.validation": { entity: { status: "completed", fund_account: { id: acc.razorpayxFundAccountId }, results: { account_status: "active" } } } });
      for (const hook of [forged, forgedValidation]) {
        let r = http().post("/v1/webhooks/razorpay");
        for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
        expect((await r.send(hook.body)).status).toBe(200);
        await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } } })).processedAt);
      }
      expect(await payoutRow(p.id)).toMatchObject({ status: "PROCESSING", utr: null });
      expect(await entry(p.id, "payout_settled")).toBeNull();
      expect((await prisma.payoutAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe("PENDING");
      // The same body signed with the RazorpayX secret on the RazorpayX endpoint is what counts.
      await deliver("payout.processed", p.id);
      expect((await payoutRow(p.id)).status).toBe("PAID");
    });

    it("a processed event for a different or missing amount puts the payout in MANUAL_REVIEW with one finance alert, funds stay locked, and the event is done (no retries)", async () => {
      const s = await ready(400_000n);
      const p = await sent(s, 100_000n);
      const row = await h.deliverX(fakeX.payoutWebhook("payout.processed", p.razorpayxPayoutId!, { amountPaise: 90_000n }));
      expect(await payoutRow(p.id)).toMatchObject({ status: "MANUAL_REVIEW", failureReason: "AMOUNT_MISMATCH" });
      expect(await entry(p.id, "payout_settled")).toBeNull();
      expect(await balances(s)).toMatchObject({ AVAILABLE: 300_000n, PAYOUT_LOCKED: 100_000n });
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(1);
      const fin = await finance();
      expect(await prisma.notification.count({ where: { userId: fin.userId, type: "finance.alert", sourceEventId: `finance:payout-mismatch:${p.id}` } })).toBe(1);
      // A repeat does nothing more; a later reversal still returns the money.
      await deliver("payout.processed", p.id, { amountPaise: 100_000n });
      expect((await payoutRow(p.id)).status).toBe("MANUAL_REVIEW");
      await deliver("payout.reversed", p.id);
      expect(await payoutRow(p.id)).toMatchObject({ status: "REVERSED" });
      expect(await balances(s)).toMatchObject({ AVAILABLE: 400_000n, PAYOUT_LOCKED: 0n });

      const q = await sent(s, 100_000n);
      await h.deliverX(fakeX.payoutWebhook("payout.processed", q.razorpayxPayoutId!, { omitAmount: true }));
      expect((await payoutRow(q.id)).status).toBe("MANUAL_REVIEW");
      expect(await entry(q.id, "payout_settled")).toBeNull();
    });

    it("the send job racing the 5-minute re-drive creates one RazorpayX payout, adopted by reference", async () => {
      const s = await ready(200_000n);
      const res = await requestPayout(s, "100000");
      await prisma.payout.update({ where: { id: res.body.id }, data: { status: "APPROVED", approvedBy: (await finance()).userId, approvedAt: new Date(t.clock.now().getTime() - 6 * 60_000) } });
      const svc = t.app.get(PayoutsService);
      const results = await Promise.allSettled([svc.send(res.body.id), svc.send(res.body.id, { recover: true }), t.app.get(PayoutMaintenanceProcessor).redrive()]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const remote = [...fakeX.payouts.values()].filter((x) => x.referenceId === res.body.id);
      expect(remote).toHaveLength(1);
      expect(await payoutRow(res.body.id)).toMatchObject({ status: "PROCESSING", razorpayxPayoutId: remote[0].id });
    });

    it("one organization's owner cannot see, list or request another organization's payouts", async () => {
      const mk = async () => {
        const o = await t.login();
        const org = (await http().post("/v1/orgs").set(auth(o)).send({ name: "Wall Org", slug: `wo-${h.uid()}` })).body as { id: string; slug: string };
        await h.stepUp(o);
        return { o, org };
      };
      const a = await mk();
      const b = await mk();
      await fund({ ownerType: "ORG", ownerId: a.org.id }, 150_000n);
      for (const path of ["me", "ledger", "payouts", "payout-account"]) {
        expect((await http().get(`/v1/orgs/${a.org.slug}/wallet/${path}`).set(auth(b.o))).status).toBe(403);
      }
      const denied = await http().post(`/v1/orgs/${a.org.slug}/wallet/payouts`).set(auth(b.o)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "100000" });
      expect(denied.status).toBe(403);
      expect((await http().put(`/v1/orgs/${a.org.slug}/wallet/payout-account`).set(auth(b.o)).send(h.bankBody())).status).toBe(403);
      expect((await ledger.balancesFor("ORG", a.org.id)).AVAILABLE).toBe(150_000n);
      expect((await http().get(`/v1/orgs/${b.org.slug}/wallet/payouts`).set(auth(b.o))).body.items).toEqual([]);
    });
  });
});
