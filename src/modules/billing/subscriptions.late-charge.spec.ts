import { SubscriptionsService } from "./subscriptions.service";

/** MON-2: a late charge on an old, expired Razorpay subscription must not revive it over the newer paid one. */
describe("SubscriptionsService.onCharged with a newer live paid subscription", () => {
  function setup() {
    const old: Record<string, unknown> = { id: "OLD", ownerType: "USER", ownerId: "U1", status: "EXPIRED", currentPeriodEnd: new Date("2026-01-01"), razorpaySubscriptionId: "sub_old", cancelAtPeriodEnd: false, scheduledPlanVersionId: null };
    const updates: unknown[] = [];
    const tx: Record<string, unknown> = {
      $queryRaw: async () => [],
      subscription: {
        findUniqueOrThrow: async () => ({ ...old }),
        findFirst: async () => ({ id: "NEW", status: "ACTIVE", razorpaySubscriptionId: "sub_new" }),
        updateMany: async (a: unknown) => (updates.push(a), { count: 1 }),
        findMany: async () => [{ id: "NEW", razorpaySubscriptionId: "sub_new", status: "EXPIRED", cancelAtPeriodEnd: false }],
      },
    };
    const prisma = { subscription: { findUnique: async () => old, ...(tx.subscription as object) }, $transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
    const razorpay = { cancelSubscription: jest.fn() };
    const ledger = { post: jest.fn(async () => ({ duplicate: false })) };
    const accounts = { platformAccount: async (k: string) => k };
    const settings = { get: async () => 1800 };
    const alerts = { raise: jest.fn() };
    const entitlements = { invalidate: jest.fn() };
    const svc = new SubscriptionsService(prisma as never, razorpay as never, entitlements as never, {} as never, ledger as never, accounts as never, settings as never, {} as never, {} as never, alerts as never, { now: () => new Date("2026-06-01") } as never, {} as never);
    const event = {
      webhookEventId: "w1",
      type: "subscription.charged",
      payload: { payload: { subscription: { entity: { id: "sub_old", current_end: Math.floor(new Date("2026-07-01").getTime() / 1000) } }, payment: { entity: { id: "pay_late", amount: 99900 } } } },
    };
    return { svc, event, updates, razorpay, alerts, ledger };
  }

  it("books the charge, leaves the old row EXPIRED and the new one alone, cancels nothing and alerts finance", async () => {
    const { svc, event, updates, razorpay, alerts, ledger } = setup();
    await svc.onCharged(event as never);
    expect(ledger.post).toHaveBeenCalled();
    expect(updates).toEqual([]); // no revive, no EXPIRE of the newer subscription
    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({ kind: "SUBSCRIPTION_LATE_CHARGE" }));
  });
});

describe("SubscriptionsService.runMaintenance grace expiry", () => {
  it("cancels the lapsed subscription at Razorpay immediately (not at cycle end)", async () => {
    const row = { id: "S1", ownerType: "USER", ownerId: "U1", status: "PAST_DUE", razorpaySubscriptionId: "sub_1", notifyUserId: null, planVersionId: "PV" };
    let first = true;
    const tx: Record<string, unknown> = {
      $queryRaw: async () => [],
      subscription: { updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => row },
      planVersion: { findUniqueOrThrow: async () => ({ plan: { key: "pro" } }) },
    };
    const prisma = {
      subscription: {
        findMany: async (a: { where: { status: string } }) => (a.where.status === "PAST_DUE" && first ? ((first = false), [row]) : []),
        updateMany: async () => ({ count: 0 }),
      },
      $transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    };
    const razorpay = { cancelSubscription: jest.fn(async () => undefined) };
    const svc = new SubscriptionsService(prisma as never, razorpay as never, { invalidate: jest.fn() } as never, {} as never, {} as never, {} as never, {} as never, { enqueue: jest.fn() } as never, {} as never, {} as never, { now: () => new Date("2026-06-01") } as never, {} as never);
    (svc as unknown as { ensureFree: () => Promise<void> }).ensureFree = async () => undefined;
    await svc.runMaintenance();
    expect(razorpay.cancelSubscription).toHaveBeenCalledWith("sub_1", false);
  });
});

describe("SubscriptionsService.runMaintenance missed renewals (MON-10)", () => {
  it("flags a paid ACTIVE subscription whose period ended more than 2 days ago without a renewal, and does not expire it", async () => {
    const row = { id: "S1", ownerType: "ORG", ownerId: "O1", status: "ACTIVE", razorpaySubscriptionId: "sub_1", currentPeriodEnd: new Date("2026-05-20") };
    const seen: Array<{ where: Record<string, unknown> }> = [];
    const prisma = {
      subscription: {
        findMany: async (a: { where: Record<string, unknown> }) => {
          seen.push(a);
          return a.where.razorpaySubscriptionId ? [row] : [];
        },
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(),
    };
    const alerts = { raise: jest.fn() };
    const svc = new SubscriptionsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, alerts as never, { now: () => new Date("2026-06-01") } as never, {} as never);
    const res = await svc.runMaintenance();
    expect(res).toMatchObject({ flagged: 1 });
    expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({ kind: "SUBSCRIPTION_LAPSED", dedupeKey: expect.stringContaining("S1") }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
