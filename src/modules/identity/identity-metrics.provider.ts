import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by identity: new accounts. */
@Injectable()
export class IdentityMetricsProvider implements MetricsProvider {
  readonly module = "identity";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const signups = await this.prisma.user.count({ where: { createdAt: { gte: from, lt: to } } });
    return [{ key: "signups", value: BigInt(signups) }];
  }
}
