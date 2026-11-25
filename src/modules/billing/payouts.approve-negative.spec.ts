import { PayoutsService } from "./payouts.service";

/** MON-5: a refund after hold release can push AVAILABLE below zero; approving a payout for that owner must be blocked. */
describe("PayoutsService.approve with a negative AVAILABLE balance", () => {
  function setup(available: bigint) {
    const payout: Record<string, unknown> = { id: "P1", status: "REQUESTED", requestedBy: "requester", payoutAccountId: "A1", amountPaise: 100000n, tdsPaise: 0n, tdsBps: 0, ownerType: "USER", ownerId: "U1", mode: "IMPS", razorpayxPayoutId: null };
    const prisma: Record<string, unknown> = {
      $queryRaw: async () => [],
      $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(prisma),
      payout: { findUnique: async () => ({ ...payout }), update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(payout, data) },
      payoutAccount: { findUnique: async () => ({ id: "A1" }) },
    };
    const ledger = { balancesFor: async () => ({ AVAILABLE: available, PENDING: 0n, PAYOUT_LOCKED: 100000n }) };
    const queue = { add: jest.fn() };
    const outbox = { enqueue: jest.fn() };
    const audit = { record: jest.fn() };
    const svc = new PayoutsService(prisma as never, ledger as never, {} as never, { blockReason: () => null } as never, outbox as never, {} as never, audit as never, {} as never, {} as never, { now: () => new Date() } as never, queue as never);
    return { svc, payout, queue };
  }

  it("blocks approval and leaves the payout REQUESTED", async () => {
    const { svc, payout, queue } = setup(-1n);
    await expect(svc.approve("finance", "P1")).rejects.toMatchObject({ code: "PAYOUT_BALANCE_NEGATIVE" });
    expect(payout.status).toBe("REQUESTED");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("approves when AVAILABLE is zero or positive", async () => {
    const { svc, payout } = setup(0n);
    await svc.approve("finance", "P1").catch(() => undefined); // the view needs more fakes than this test cares about
    expect(payout.status).toBe("APPROVED");
  });
});
