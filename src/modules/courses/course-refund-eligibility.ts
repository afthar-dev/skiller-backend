import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { RefundEligibilityRegistry, type PaidOrder, type RefundEligibility, type RefundEligibilityResult } from "../billing";
import { COURSE_PROGRESS_READER, type CourseProgressReader } from "./course-progress";

/** A course can be refunded only while less than this share of its required lessons is completed. */
export const REFUND_MAX_COMPLETED_PCT = 30;

/**
 * Refunds for a course: the platform default (within 7 days of payment) and, on top of it, less than 30% of the required
 * lessons completed. Registered in the API and in the worker (automatic refunds of undeliverable orders are checked there).
 */
@Injectable()
export class CourseRefundEligibility implements RefundEligibility, OnModuleInit {
  private readonly window: RefundEligibility;

  constructor(
    private readonly registry: RefundEligibilityRegistry,
    @Inject(COURSE_PROGRESS_READER) private readonly progress: CourseProgressReader,
  ) {
    // Nothing is registered for COURSE yet, so this is the platform default: reuse its window instead of copying it.
    this.window = registry.forType("COURSE");
  }

  onModuleInit() {
    this.registry.register("COURSE", this);
  }

  async check(input: { order: PaidOrder; now: Date; db?: Prisma.TransactionClient }): Promise<RefundEligibilityResult> {
    const inWindow = await this.window.check(input);
    if (!inWindow.eligible) return inWindow;
    const pct = await this.progress.completedRequiredPct(input.order.buyerId, input.order.items[0].itemId, input.db);
    if (pct >= REFUND_MAX_COMPLETED_PCT) {
      return { eligible: false, reason: `Refunds are possible only while less than ${REFUND_MAX_COMPLETED_PCT}% of the course is completed` };
    }
    return { eligible: true };
  }
}
