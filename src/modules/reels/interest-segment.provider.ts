import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { SegmentProvider } from "../../common/segments/segment-provider";
import { MIN_INTEREST_WEIGHT } from "./interests.service";

/** Segment criterion `interests`: users with a live interest in any of these keys (`tag:<hashtag>`, `cat:<categoryId>`). */
@Injectable()
export class InterestSegmentProvider implements SegmentProvider {
  readonly key = "interests" as const;

  constructor(private readonly prisma: PrismaService) {}

  async match(userIds: string[], criterion: unknown): Promise<Set<string>> {
    const keys = Array.isArray(criterion) ? criterion.filter((k): k is string => typeof k === "string") : [];
    if (userIds.length === 0 || keys.length === 0) return new Set();
    const rows = await this.prisma.userInterest.findMany({ where: { userId: { in: userIds }, key: { in: keys }, weight: { gte: MIN_INTEREST_WEIGHT } }, select: { userId: true }, distinct: ["userId"] });
    return new Set(rows.map((r) => r.userId));
  }
}
