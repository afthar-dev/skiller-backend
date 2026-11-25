import { PayoutsService } from "./payouts.service";
import { RazorpayApiError } from "./razorpay.client";

/** MON-3: send() and the redrive of one payout must never run the RazorpayX call concurrently. */
describe("PayoutsService.send concurrency", () => {
  function setup() {
    const payout: Record<string, unknown> = {
      id: "P1",
      status: "APPROVED",
      razorpayxPayoutId: null,
      payoutAccountId: "A1",
      amountPaise: 100000n,
      tdsPaise: 0n,
      ownerType: "USER",
      ownerId: "U1",
      mode: "IMPS",
    };
    // One transaction at a time stands in for the payout row lock (SELECT .. FOR UPDATE) every locked path takes.
    let chain: Promise<unknown> = Promise.resolve();
    const prisma: Record<string, unknown> = {
      $queryRaw: async () => [],
      $transaction: (cb: (tx: unknown) => Promise<unknown>) => {
        const run = chain.then(() => cb(prisma));
        chain = run.catch(() => undefined);
        return run;
      },
      payout: {
        findUniqueOrThrow: async () => ({ ...payout }),
        findUnique: async () => ({ ...payout }),
        updateMany: async ({ where, data }: { where: { status: string; razorpayxPayoutId: null }; data: Record<string, unknown> }) => {
          if (payout.status !== where.status || payout.razorpayxPayoutId !== where.razorpayxPayoutId) return { count: 0 };
          Object.assign(payout, data);
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(payout, data),
      },
      payoutAccount: { findUniqueOrThrow: async () => ({ id: "A1", razorpayxFundAccountId: "fa_1" }), findUnique: async () => ({ id: "A1", razorpayxFundAccountId: "fa_1" }) },
    };

    let inFlight = false;
    let remote: { id: string } | null = null;
    let creates = 0;
    const razorpayx = {
      findPayoutByReference: async () => remote,
      createPayout: async () => {
        creates += 1;
        // RazorpayX answers a concurrent request with the same idempotency key with a 409.
        if (inFlight) throw new RazorpayApiError(409, "BAD_REQUEST_ERROR", "request with the same idempotency key is in progress");
        inFlight = true;
        await new Promise((r) => setTimeout(r, 30));
        remote = { id: "pout_1" };
        inFlight = false;
        return remote;
      },
    };
    const ledger = { post: jest.fn() };
    const accounts = { ensureSellerAccounts: async () => ({ AVAILABLE: "av", PAYOUT_LOCKED: "pl" }) };
    const payoutAccounts = { blockReason: () => null };
    const outbox = { enqueue: jest.fn() };
    const alerts = { raise: jest.fn() };
    const svc = new PayoutsService(prisma as never, ledger as never, accounts as never, payoutAccounts as never, outbox as never, {} as never, { record: jest.fn() } as never, alerts as never, razorpayx as never, { now: () => new Date() } as never, {} as never);
    return { svc, payout, ledger, alerts, creates: () => creates };
  }

  it("the send job and the redrive racing never fail the payout while a remote payout exists", async () => {
    const { svc, payout, ledger, alerts, creates } = setup();
    await Promise.allSettled([svc.send("P1"), svc.send("P1", { recover: true })]);
    expect(payout.status).toBe("PROCESSING");
    expect(payout.razorpayxPayoutId).toBe("pout_1");
    expect(creates()).toBe(1);
    expect(ledger.post).not.toHaveBeenCalled();
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it("a 409 from RazorpayX is treated as an outage (stays APPROVED for a retry), not a refusal", async () => {
    const { svc, payout, ledger } = setup();
    (svc as unknown as { razorpayx: { createPayout: () => never } }).razorpayx.createPayout = () => {
      throw new RazorpayApiError(409, "BAD_REQUEST_ERROR", "request with the same idempotency key is in progress");
    };
    await expect(svc.send("P1")).rejects.toMatchObject({ code: "PAYOUT_GATEWAY_ERROR" });
    expect(payout.status).toBe("APPROVED");
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
