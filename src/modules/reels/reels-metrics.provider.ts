import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by reels: reels published, views counted that IST day (the flushed per-day totals) and new comments. */
@Injectable()
export class ReelsMetricsProvider implements MetricsProvider {
  readonly module = "reels";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [posted, views, comments] = await Promise.all([
      this.prisma.reel.count({ where: { publishedAt: { gte: from, lt: to } } }),
      this.prisma.reelViewDaily.aggregate({ where: { day }, _sum: { views: true } }),
      this.prisma.reelComment.count({ where: { createdAt: { gte: from, lt: to } } }),
    ]);
    return [
      { key: "reels_posted", value: BigInt(posted) },
      { key: "reel_views", value: BigInt(views._sum.views ?? 0) },
      { key: "reel_comments", value: BigInt(comments) },
    ];
  }
}
