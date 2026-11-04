import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import * as sentryModule from "../../src/common/observability/sentry";
import { queueToken } from "../../src/common/queue/queue.constants";
import { FakeRazorpayClient, FakeRazorpayXClient, RAZORPAY_CLIENT, RAZORPAYX_CLIENT, ReconciliationProcessor, ReconciliationService } from "../../src/modules/billing";
import { addDays, istDayRange, previousIstDay } from "../../src/modules/billing/ist";
import { RolesService } from "../../src/modules/rbac";
import { AccountsService, LedgerService } from "../../src/modules/wallet";
import { createAuthTestApp, type AuthTestApp } from "../support/auth-app";
import { paidOrder } from "../support/orders";
import { payoutHelpers, until, type Session } from "../support/payouts";
import { removeAllSchedulers } from "../support/schedulers";
import { TestItemProvider } from "../support/test-item";

const HOUR = 3_600_000;

describe("nightly reconciliation", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let svc: ReconciliationService;
  let ledger: LedgerService;
  let accts: AccountsService;
  let h: ReturnType<typeof payoutHelpers>;
  let admin: Session;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  // Each test reconciles its own far-future IST day, so nothing another suite wrote can fall inside the window.
  let dayCounter = 0;
  const nextDay = () => addDays("2031-01-01", dayCounter++);
  const at = (date: string, hour = 12) => new Date(istDayRange(date).from.getTime() + hour * HOUR);
  const unix = (d: Date) => Math.floor(d.getTime() / 1000);

  async function paidOn(date: string, pricePaise = 100000n) {
    const o = await paidOrder(t, fake, { pricePaise });
    const when = at(date);
    await prisma.order.update({ where: { id: o.orderId }, data: { paidAt: when } });
    fake.payments.set(o.paymentId, { ...fake.payments.get(o.paymentId)!, createdAt: unix(when) });
    return o;
  }

  // A finance admin with a fresh step-up. Sessions are resolved BEFORE a request object exists (supertest closes the shared server per request).
  async function financeAdmin(): Promise<Session> {
    if (!admin) {
      admin = await t.login();
      await t.app.get(RolesService).grantSystem(admin.userId, "finance_admin");
      await h.stepUp(admin); // valid for several minutes; the clock only moves in the last test
    }
    return admin;
  }

  async function fund(userId: string, paise: bigint) {
    await prisma.$transaction(async (tx) => {
      const s = await accts.ensureSellerAccounts(tx, "USER", userId);
      const clearing = await accts.platformAccount("GATEWAY_CLEARING", tx);
      await ledger.post(tx, { refType: "TEST_FUND", refId: randomUUID(), description: "fund", lines: [{ accountId: clearing, amountPaise: -paise }, { accountId: s.AVAILABLE, amountPaise: paise }] });
    });
  }

  const items = (run: { details: unknown }, section: "payments" | "settlements") => (run.details as Record<string, { items: { kind: string; paymentId?: string }[] }>)[section].items;
  const age = (table: "payouts" | "refunds", ids: string[]) =>
    prisma.$executeRawUnsafe(`UPDATE "${table}" SET "updatedAt" = $1 WHERE "id" = ANY($2::text[])`, new Date(t.clock.now().getTime() - 3 * HOUR), ids);

  beforeAll(async () => {
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake).overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    prisma = t.app.get(PrismaService);
    svc = t.app.get(ReconciliationService);
    ledger = t.app.get(LedgerService);
    accts = t.app.get(AccountsService);
    h = payoutHelpers(t, prisma, fakeX);
  });
  afterAll(async () => {
    if (t) await removeAllSchedulers(t.app);
    await t?.close();
  });

  it("a day where gateway and books agree is OK, and rerunning the same day updates the one row", async () => {
    const day = nextDay();
    await paidOn(day);
    const run = await svc.run(day);
    expect(run.status).toBe("OK");
    expect(items(run, "payments")).toEqual([]);
    expect((run.details as { payments: { gatewayCount: number; booksCount: number } }).payments).toMatchObject({ gatewayCount: 1, booksCount: 1 });
    expect((run.details as { ledger: { totalPaise: string; drift: unknown[] } }).ledger).toMatchObject({ totalPaise: "0", drift: [] });
    const again = await svc.run(day);
    expect(again.id).toBe(run.id);
    expect(await prisma.reconciliationRun.count({ where: { date: day } })).toBe(1);
  });

  it("a captured payment with no PAID order is a MISMATCH, alerts every finance admin and reports to Sentry", async () => {
    const day = nextDay();
    const a = await financeAdmin();
    const stray = fake.capturePaymentWithoutOrder(55500n, { createdAt: unix(at(day)) });
    const sentry = jest.spyOn(sentryModule, "reportException").mockImplementation(() => undefined);
    try {
      const run = await svc.run(day);
      expect(run.status).toBe("MISMATCH");
      expect(items(run, "payments")).toEqual([expect.objectContaining({ kind: "UNRECORDED_PAYMENT", paymentId: stray.id, gatewayPaise: "55500" })]);
      expect(sentry).toHaveBeenCalled();
    } finally {
      sentry.mockRestore();
    }
    const note = await prisma.notification.findFirst({ where: { userId: a.userId, sourceEventId: `finance:reconciliation:${day}:MISMATCH` } });
    expect(note).toMatchObject({ type: "finance.alert" });
    // Once the payment is gone from the gateway's view, the rerun is clean and replaces the result.
    fake.payments.delete(stray.id);
    expect((await svc.run(day)).status).toBe("OK");
  });

  it("a PAID order the gateway does not know, and a different amount, are both caught", async () => {
    const day = nextDay();
    const missing = await paidOn(day);
    const wrong = await paidOn(day, 250000n);
    fake.payments.delete(missing.paymentId);
    fake.payments.set(wrong.paymentId, { ...fake.payments.get(wrong.paymentId)!, amountPaise: 249999n });
    const run = await svc.run(day);
    expect(run.status).toBe("MISMATCH");
    expect(items(run, "payments")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "MISSING_AT_GATEWAY", paymentId: missing.paymentId }),
        expect.objectContaining({ kind: "AMOUNT_MISMATCH", paymentId: wrong.paymentId, gatewayPaise: "249999", booksPaise: "250000" }),
      ]),
    );
  });

  it("a charged subscription is matched to its gateway payment by id; a refunded order still counts as booked", async () => {
    const day = nextDay();
    const payId = `pay_sub_${randomUUID().slice(0, 8)}`;
    fake.capturePaymentWithoutOrder(99900n, { id: payId, createdAt: unix(at(day)) });
    await prisma.$transaction(async (tx) => {
      const clearing = await accts.platformAccount("GATEWAY_CLEARING", tx);
      const revenue = await accts.platformAccount("PLATFORM_REVENUE", tx);
      const tax = await accts.platformAccount("TAX_PAYABLE", tx);
      await ledger.post(tx, {
        refType: "SUBSCRIPTION_CHARGE",
        refId: payId,
        description: "Subscription charge",
        lines: [
          { accountId: clearing, amountPaise: -99900n },
          { accountId: revenue, amountPaise: 84661n },
          { accountId: tax, amountPaise: 15239n },
        ],
      });
    });
    await prisma.$executeRaw`UPDATE "journal_entries" SET "createdAt" = ${at(day)} WHERE "refType" = 'SUBSCRIPTION_CHARGE' AND "refId" = ${payId}`;
    const refunded = await paidOn(day);
    await prisma.order.update({ where: { id: refunded.orderId }, data: { status: "REFUNDED" } });
    expect((await svc.run(day)).status).toBe("OK");
    fake.payments.delete(payId);
    const run = await svc.run(day);
    expect(run.status).toBe("MISMATCH");
    expect(items(run, "payments")).toEqual([expect.objectContaining({ kind: "MISSING_AT_GATEWAY", paymentId: payId })]);
  });

  it("settlements: a failed one, or one larger than everything booked, is a MISMATCH; a normal one is not", async () => {
    const day = nextDay();
    await paidOn(day);
    fake.settlements.push({ id: "setl_ok", amountPaise: 1000n, feesPaise: 20n, taxPaise: 4n, status: "processed", createdAt: unix(at(day, 6)) });
    expect((await svc.run(day)).status).toBe("OK");
    fake.settlements.push({ id: "setl_bad", amountPaise: 1000n, feesPaise: 0n, taxPaise: 0n, status: "failed", createdAt: unix(at(day, 7)) });
    fake.settlements.push({ id: "setl_huge", amountPaise: 900_000_000_000_000n, feesPaise: 0n, taxPaise: 0n, status: "processed", createdAt: unix(at(day, 8)) });
    const run = await svc.run(day);
    expect(run.status).toBe("MISMATCH");
    expect(items(run, "settlements").map((i) => i.kind).sort()).toEqual(["SETTLEMENT_EXCEEDS_BOOKED", "SETTLEMENT_FAILED"]);
  });

  it("a drifted account_balances row is reported by account, and the run recovers once it is repaired", async () => {
    const day = nextDay();
    const sellerId = (await t.login()).userId;
    const accountId = await prisma.$transaction(async (tx) => (await accts.ensureSellerAccounts(tx, "USER", sellerId)).AVAILABLE);
    await prisma.$executeRaw`UPDATE "account_balances" SET "balancePaise" = "balancePaise" + 7 WHERE "accountId" = ${accountId}`;
    try {
      const run = await svc.run(day);
      expect(run.status).toBe("MISMATCH");
      const drift = (run.details as { ledger: { drift: { accountId: string; storedPaise: string; linesPaise: string }[] } }).ledger.drift;
      expect(drift).toEqual([expect.objectContaining({ accountId, storedPaise: "7", linesPaise: "0" })]);
      expect(await prisma.notification.findFirst({ where: { sourceEventId: `finance:reconciliation:${day}:MISMATCH` } })).not.toBeNull();
    } finally {
      await prisma.$executeRaw`UPDATE "account_balances" SET "balancePaise" = "balancePaise" - 7 WHERE "accountId" = ${accountId}`;
    }
    expect((await svc.run(day)).status).toBe("OK");
  });

  it("an unreachable gateway makes the run ERROR (and alerts), not OK", async () => {
    const day = nextDay();
    fake.failNext.set("listCapturedPayments", new Error("gateway down"));
    const run = await svc.run(day);
    expect(run.status).toBe("ERROR");
    expect((run.details as { errors: { section: string; message: string }[] }).errors).toEqual([expect.objectContaining({ section: "payments", message: expect.stringContaining("gateway down") })]);
    expect((await svc.run(day)).status).toBe("OK");
  });

  it("a payout stuck PROCESSING for over 2 hours is fetched from RazorpayX and settled through the webhook code path", async () => {
    const day = nextDay();
    const seller = await h.creatorWithAccount();
    await fund(seller.userId, 200000n);
    await h.stepUp(seller);
    const asked = await http().post("/v1/wallet/payouts").set(auth(seller)).set("Idempotency-Key", randomUUID()).send({ amountPaise: "100000" });
    expect(asked.status).toBe(201);
    const a = await financeAdmin();
    expect((await http().post(`/v1/admin/payouts/${asked.body.id}/approve`).set(auth(a)).send({})).status).toBe(200);
    const row = await until(async () => {
      const p = await prisma.payout.findUniqueOrThrow({ where: { id: asked.body.id } });
      return p.status === "PROCESSING" && p;
    });
    // A young payout is left alone.
    expect((await svc.run(day)).details).toMatchObject({ stuck: { payouts: [] } });
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PROCESSING");

    await age("payouts", [row.id]);
    const remote = fakeX.payouts.get(row.razorpayxPayoutId!)!;
    remote.status = "processed";
    remote.utr = "UTR123456";
    const run = await svc.run(day);
    expect((run.details as { stuck: { payouts: { payoutId: string; outcome: string }[] } }).stuck.payouts).toEqual([expect.objectContaining({ payoutId: row.id, outcome: "PAID" })]);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "PAID", utr: "UTR123456" });
    expect(await prisma.journalEntry.count({ where: { refType: "PAYOUT", refId: row.id, description: "payout_settled" } })).toBe(1);
  });

  it("a payout RazorpayX reports failed is unlocked, and one still processing stays as it is", async () => {
    const day = nextDay();
    const seller = await h.creatorWithAccount();
    await fund(seller.userId, 300000n);
    const ids: string[] = [];
    for (const amount of ["60000", "70000"]) {
      await h.stepUp(seller);
      const asked = await http().post("/v1/wallet/payouts").set(auth(seller)).set("Idempotency-Key", randomUUID()).send({ amountPaise: amount });
      expect(asked.status).toBe(201);
      const a = await financeAdmin();
      await http().post(`/v1/admin/payouts/${asked.body.id}/approve`).set(auth(a)).send({}).expect(200);
      await until(async () => (await prisma.payout.findUniqueOrThrow({ where: { id: asked.body.id } })).status === "PROCESSING");
      ids.push(asked.body.id);
    }
    const [failing, waiting] = await Promise.all(ids.map((id) => prisma.payout.findUniqueOrThrow({ where: { id } })));
    await age("payouts", ids);
    const remote = fakeX.payouts.get(failing.razorpayxPayoutId!)!;
    remote.status = "failed";
    remote.failureReason = "Beneficiary bank rejected the payment";
    const run = await svc.run(day);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: failing.id } })).status).toBe("FAILED");
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("PROCESSING");
    expect((run.details as { stuck: { payouts: { payoutId: string; outcome: string }[] } }).stuck.payouts).toEqual(
      expect.arrayContaining([expect.objectContaining({ payoutId: failing.id, outcome: "FAILED" }), expect.objectContaining({ payoutId: waiting.id, outcome: "STILL_PROCESSING" })]),
    );
  });

  it("a refund stuck PROCESSING for over 2 hours is fetched from Razorpay and applied", async () => {
    const day = nextDay();
    const o = await paidOn(day);
    const asked = await http().post(`/v1/orders/${o.orderId}/refund-requests`).set(auth(o.buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Not what I expected" });
    expect(asked.status).toBe(201);
    const a = await financeAdmin();
    await http().post(`/v1/admin/refunds/${asked.body.id}/approve`).set(auth(a)).send({}).expect(200);
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id } });
    expect(refund.status).toBe("PROCESSING");
    expect((await svc.run(day)).details).toMatchObject({ stuck: { refunds: [] } });
    await age("refunds", [refund.id]);
    const run = await svc.run(day);
    expect((run.details as { stuck: { refunds: { refundId: string; outcome: string }[] } }).stuck.refunds).toEqual([expect.objectContaining({ refundId: refund.id, outcome: "PROCESSED" })]);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("PROCESSED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("REFUNDED");
  });

  describe("admin API and schedule", () => {
    it("POST /v1/admin/finance/reconciliation/run needs finance.reconcile and step-up, runs the day and audits it; GET lists the runs", async () => {
      const day = nextDay();
      await paidOn(day);
      const nobody = await t.login();
      expect((await http().post("/v1/admin/finance/reconciliation/run").set(auth(nobody)).send({ date: day })).status).toBe(403);

      const a = await financeAdmin();
      const bad = await http().post("/v1/admin/finance/reconciliation/run").set(auth(a)).send({ date: "2031-02-30" });
      expect(bad.status).toBe(400);
      const res = await http().post("/v1/admin/finance/reconciliation/run").set(auth(a)).send({ date: day });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: day, status: "OK" });
      expect(await prisma.auditLog.count({ where: { action: "finance.reconciliation.run", targetId: res.body.id } })).toBe(1);

      const list = await http().get("/v1/admin/finance/reconciliation?limit=50").set(auth(a));
      expect(list.status).toBe(200);
      expect(list.body.items.map((r: { date: string }) => r.date)).toContain(day);
      expect((await http().get("/v1/admin/finance/reconciliation").set(auth(nobody))).status).toBe(403);
    });

    it("is scheduled for 02:00 IST (Asia/Kolkata) and the job reconciles the previous IST day", async () => {
      const processor = t.app.get(ReconciliationProcessor);
      await processor.schedule();
      const schedulers = await t.app.get<import("bullmq").Queue>(queueToken("maintenance")).getJobSchedulers();
      expect(schedulers.find((x) => x.key === "reconciliation.nightly")).toMatchObject({ pattern: "0 2 * * *", tz: "Asia/Kolkata" });
      // The clock stays put (moving it would make every payout other suites left PROCESSING look stuck); previousIstDay itself is unit-tested.
      const expected = previousIstDay(t.clock.now());
      const out = (await processor.process({} as never)) as { date: string; status: string };
      expect(out.date).toBe(expected);
      expect(["OK", "MISMATCH", "ERROR"]).toContain(out.status);
      expect(await prisma.reconciliationRun.count({ where: { date: expected } })).toBe(1);
    });
  });
});
