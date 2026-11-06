import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by growth: campaign mails sent, opened and clicked that day (each recipient counts once per event, as the stats do). */
@Injectable()
export class GrowthMetricsProvider implements MetricsProvider {
  readonly module = "growth";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [sends, opens, clicks] = await Promise.all([
      this.prisma.campaignRecipient.count({ where: { sentAt: { gte: from, lt: to } } }),
      this.prisma.campaignRecipient.count({ where: { openedAt: { gte: from, lt: to } } }),
      this.prisma.campaignRecipient.count({ where: { clickedAt: { gte: from, lt: to } } }),
    ]);
    return [
      { key: "campaign_sends", value: BigInt(sends) },
      { key: "campaign_opens", value: BigInt(opens) },
      { key: "campaign_clicks", value: BigInt(clicks) },
    ];
  }
}
