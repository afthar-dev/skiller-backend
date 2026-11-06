import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { SegmentProvider } from "../../common/segments/segment-provider";

const DAY_MS = 24 * 3600_000;

/** Segment criterion `lastActive`: `{ withinDays: n }` = signed in (a session used) in the last n days; `{ inactiveDays: n }` = not for n days (or never). */
@Injectable()
export class ActivitySegmentProvider implements SegmentProvider {
  readonly key = "lastActive" as const;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async match(userIds: string[], criterion: unknown): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const c = (criterion ?? {}) as { withinDays?: number; inactiveDays?: number };
    const now = this.clock.now().getTime();
    const since = c.withinDays !== undefined ? new Date(now - c.withinDays * DAY_MS) : c.inactiveDays !== undefined ? new Date(now - c.inactiveDays * DAY_MS) : null;
    if (!since) return new Set();
    const rows = await this.prisma.session.findMany({ where: { userId: { in: userIds }, lastUsedAt: { gte: since } }, select: { userId: true }, distinct: ["userId"] });
    const recent = new Set(rows.map((r) => r.userId));
    return c.withinDays !== undefined ? recent : new Set(userIds.filter((id) => !recent.has(id)));
  }
}
