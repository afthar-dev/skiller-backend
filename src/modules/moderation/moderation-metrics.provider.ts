import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by moderation: reports opened that day and reports upheld (decided) that day. */
@Injectable()
export class ModerationMetricsProvider implements MetricsProvider {
  readonly module = "moderation";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [opened, upheld] = await Promise.all([
      this.prisma.report.count({ where: { createdAt: { gte: from, lt: to } } }),
      this.prisma.report.count({ where: { status: "UPHELD", decidedAt: { gte: from, lt: to } } }),
    ]);
    return [
      { key: "reports_opened", value: BigInt(opened) },
      { key: "reports_upheld", value: BigInt(upheld) },
    ];
  }
}
