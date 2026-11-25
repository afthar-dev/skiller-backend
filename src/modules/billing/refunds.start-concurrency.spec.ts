import { RefundsService } from "./refunds.service";
import { RazorpayApiError } from "./razorpay.client";

/** MON-3 (refunds): approve/start, resumeStuck and refundUndelivered must never run createRefund for one refund concurrently. */
describe("RefundsService.start concurrency", () => {
  function setup() {
    const refund: Record<string, unknown> = { id: "R1", orderId: "O1", status: "APPROVED", razorpayRefundId: null, amountPaise: 5000n, order: { id: "O1", razorpayPaymentId: "pay_1" } };
    let chain: Promise<unknown> = Promise.resolve();
    const prisma: Record<string, unknown> = {
      $queryRaw: async () => [],
      $transaction: (cb: (tx: unknown) => Promise<unknown>) => {
        const run = chain.then(() => cb(prisma));
        chain = run.catch(() => undefined);
        return run;
      },
      refund: {
        findUniqueOrThrow: async () => ({ ...refund }),
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(refund, data),
        updateMany: async ({ where, data }: { where: { status: unknown; razorpayRefundId?: null }; data: Record<string, unknown> }) => {
          if (refund.status !== where.status || refund.razorpayRefundId !== (where.razorpayRefundId ?? null)) return { count: 0 };
          Object.assign(refund, data);
          return { count: 1 };
        },
      },
    };
    let inFlight = false;
    let created: { id: string } | null = null;
    let creates = 0;
    const razorpay = {
      createRefund: async () => {
        creates += 1;
        if (inFlight) throw new RazorpayApiError(409, "BAD_REQUEST_ERROR", "same idempotency key in progress");
        inFlight = true;
        await new Promise((r) => setTimeout(r, 30));
        created = { id: "rfnd_1" };
        inFlight = false;
        return created;
      },
      listRefunds: async () => (created ? [{ id: created.id, notes: { refundId: "R1" } }] : []),
    };
    const alerts = { raise: jest.fn() };
    const svc = new RefundsService(prisma as never, razorpay as never, {} as never, {} as never, {} as never, {} as never, {} as never, alerts as never, { now: () => new Date() } as never);
    return { svc, refund, alerts, razorpay, creates: () => creates };
  }

  it("two concurrent starts create one Razorpay refund and never fail the refund", async () => {
    const { svc, refund, alerts, creates } = setup();
    await Promise.allSettled([svc.start("R1"), svc.start("R1")]);
    expect(refund.status).toBe("PROCESSING");
    expect(refund.razorpayRefundId).toBe("rfnd_1");
    expect(creates()).toBe(1);
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it("a 409 is an outage: the refund stays APPROVED for a retry", async () => {
    const { svc, refund, razorpay } = setup();
    razorpay.createRefund = async () => {
      throw new RazorpayApiError(409, "BAD_REQUEST_ERROR", "same idempotency key in progress");
    };
    await expect(svc.start("R1")).rejects.toMatchObject({ code: "REFUND_GATEWAY_ERROR" });
    expect(refund.status).toBe("APPROVED");
  });
});
