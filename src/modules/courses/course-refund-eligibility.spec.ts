import type { PaidOrder, RefundEligibility, RefundEligibilityRegistry } from "../billing";
import { CourseRefundEligibility } from "./course-refund-eligibility";

const order = { id: "o1", buyerId: "u1", paidAt: new Date("2026-11-01T00:00:00Z"), items: [{ itemType: "COURSE", itemId: "c1" }] } as unknown as PaidOrder;
const now = new Date("2026-11-02T00:00:00Z");

function make(pct: number, base: RefundEligibility = { check: async () => ({ eligible: true }) }) {
  const asked: Array<[string, string]> = [];
  const registry = { forType: () => base } as unknown as RefundEligibilityRegistry;
  const rule = new CourseRefundEligibility(registry, {
    completedRequiredPct: async (userId, courseId) => {
      asked.push([userId, courseId]);
      return pct;
    },
  });
  return { rule, asked };
}

describe("CourseRefundEligibility", () => {
  it("is eligible below 30% completed, asking about the buyer and the course of the order", async () => {
    const { rule, asked } = make(29.99);
    expect(await rule.check({ order, now })).toEqual({ eligible: true });
    expect(asked).toEqual([["u1", "c1"]]);
  });

  it.each([30, 35, 100])("is not eligible at %s% completed, and says why", async (pct) => {
    const verdict = await make(pct).rule.check({ order, now });
    expect(verdict).toMatchObject({ eligible: false });
    expect((verdict as { reason: string }).reason).toMatch(/30%/);
  });

  it("keeps the default window: a refusal there wins and the progress is not even read", async () => {
    const { rule, asked } = make(0, { check: async () => ({ eligible: false, reason: "Refunds are possible within 7 days of payment" }) });
    expect(await rule.check({ order, now })).toEqual({ eligible: false, reason: "Refunds are possible within 7 days of payment" });
    expect(asked).toEqual([]);
  });
});
