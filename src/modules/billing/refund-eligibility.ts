import { Injectable } from "@nestjs/common";
import type { PaidOrder } from "./sellable.registry";

export type RefundEligibilityResult = { eligible: true } | { eligible: false; reason: string };

/**
 * Item-specific refund rules, registered per sellable type (Phase 3 adds "less than 30% of the course consumed" for courses).
 * The service has already checked the generic facts (the order is PAID, no refund is live); this decides the rest.
 */
export interface RefundEligibility {
  check(input: { order: PaidOrder; now: Date }): Promise<RefundEligibilityResult>;
}

export const REFUND_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Phase 2 default: within 7 days of the payment. */
@Injectable()
export class DefaultRefundEligibility implements RefundEligibility {
  async check({ order, now }: { order: PaidOrder; now: Date }): Promise<RefundEligibilityResult> {
    if (!order.paidAt) return { eligible: false, reason: "The order has not been paid" };
    if (now.getTime() > order.paidAt.getTime() + REFUND_WINDOW_DAYS * DAY_MS) {
      return { eligible: false, reason: `Refunds are possible within ${REFUND_WINDOW_DAYS} days of payment` };
    }
    return { eligible: true };
  }
}

/** Registry of eligibility rules by item type; a type without its own rule uses the default. Register in both the API and the worker. */
@Injectable()
export class RefundEligibilityRegistry {
  private readonly byType = new Map<string, RefundEligibility>();

  constructor(private readonly fallback: DefaultRefundEligibility) {}

  register(itemType: string, rule: RefundEligibility): void {
    if (this.byType.has(itemType)) throw new Error(`a refund eligibility rule is already registered for ${itemType}`);
    this.byType.set(itemType, rule);
  }

  forType(itemType: string): RefundEligibility {
    return this.byType.get(itemType) ?? this.fallback;
  }
}
