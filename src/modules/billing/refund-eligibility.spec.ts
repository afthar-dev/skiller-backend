import { DefaultRefundEligibility, RefundEligibilityRegistry, REFUND_WINDOW_DAYS } from "./refund-eligibility";
import type { PaidOrder } from "./sellable.registry";

const DAY = 86_400_000;
const orderPaidAt = (paidAt: Date | null) => ({ paidAt, items: [{ itemType: "TEST_ITEM" }] }) as unknown as PaidOrder;

describe("refund eligibility", () => {
  const rule = new DefaultRefundEligibility();
  const paid = new Date("2026-11-03T10:00:00Z");

  it("the default allows a refund up to 7 days after payment and not a moment later", async () => {
    expect(REFUND_WINDOW_DAYS).toBe(7);
    expect(await rule.check({ order: orderPaidAt(paid), now: new Date(paid.getTime() + 7 * DAY) })).toEqual({ eligible: true });
    const late = await rule.check({ order: orderPaidAt(paid), now: new Date(paid.getTime() + 7 * DAY + 1) });
    expect(late).toMatchObject({ eligible: false });
  });

  it("an order without a payment time is not eligible", async () => {
    expect(await rule.check({ order: orderPaidAt(null), now: paid })).toMatchObject({ eligible: false });
  });

  it("a rule registered for an item type wins over the default; other types use the default; a type registers once", async () => {
    const registry = new RefundEligibilityRegistry(rule);
    const strict = { check: async () => ({ eligible: false as const, reason: "30% consumed" }) };
    registry.register("COURSE", strict);
    expect(registry.forType("COURSE")).toBe(strict);
    expect(registry.forType("TEST_ITEM")).toBe(rule);
    expect(() => registry.register("COURSE", strict)).toThrow(/already registered/);
  });
});
