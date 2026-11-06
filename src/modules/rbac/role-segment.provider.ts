import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { SegmentProvider } from "../../common/segments/segment-provider";

/** Segment criterion `roles`: users holding any of these role keys (platform grants and organization memberships, unexpired). */
@Injectable()
export class RoleSegmentProvider implements SegmentProvider {
  readonly key = "roles" as const;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async match(userIds: string[], criterion: unknown): Promise<Set<string>> {
    const keys = Array.isArray(criterion) ? criterion.filter((k): k is string => typeof k === "string") : [];
    if (userIds.length === 0 || keys.length === 0) return new Set();
    const now = this.clock.now();
    const rows = await this.prisma.userRole.findMany({
      where: { userId: { in: userIds }, role: { key: { in: keys } }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true },
      distinct: ["userId"],
    });
    return new Set(rows.map((r) => r.userId));
  }
}
