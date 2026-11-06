import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { SegmentProvider } from "../../common/segments/segment-provider";

const LIVE = ["ACTIVE", "TRIALING", "PAST_DUE"] as const;

/**
 * Segment criterion `plan`: users on any of these plan keys. A user with no live paid subscription is on the free plan, so `free` matches them
 * too (and also users whose live subscription is the free plan itself).
 */
@Injectable()
export class PlanSegmentProvider implements SegmentProvider {
  readonly key = "plan" as const;

  constructor(private readonly prisma: PrismaService) {}

  async match(userIds: string[], criterion: unknown): Promise<Set<string>> {
    const keys = Array.isArray(criterion) ? criterion.filter((k): k is string => typeof k === "string") : [];
    if (userIds.length === 0 || keys.length === 0) return new Set();
    const live = await this.prisma.subscription.findMany({
      where: { ownerType: "USER", ownerId: { in: userIds }, status: { in: [...LIVE] } },
      select: { ownerId: true, planVersion: { select: { plan: { select: { key: true } } } } },
    });
    const wanted = new Set(keys);
    const matched = new Set<string>();
    const withPaid = new Set<string>();
    for (const s of live) {
      const planKey = s.planVersion.plan.key;
      if (planKey !== "free") withPaid.add(s.ownerId);
      if (wanted.has(planKey)) matched.add(s.ownerId);
    }
    if (wanted.has("free")) for (const id of userIds) if (!withPaid.has(id)) matched.add(id);
    return matched;
  }
}

/** Segment criterion `hasPurchased`: true = at least one paid order (refunded ones included: they did buy), false = none. */
@Injectable()
export class PurchaseSegmentProvider implements SegmentProvider {
  readonly key = "hasPurchased" as const;

  constructor(private readonly prisma: PrismaService) {}

  async match(userIds: string[], criterion: unknown): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.order.findMany({
      where: { buyerId: { in: userIds }, status: { in: ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] }, paidAt: { not: null } },
      select: { buyerId: true },
      distinct: ["buyerId"],
    });
    const bought = new Set(rows.map((r) => r.buyerId));
    return criterion === true ? bought : new Set(userIds.filter((id) => !bought.has(id)));
  }
}
