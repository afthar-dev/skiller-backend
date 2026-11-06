import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by rbac: members who became creators (the platform-wide `creator` role was granted that day). */
@Injectable()
export class RbacMetricsProvider implements MetricsProvider {
  readonly module = "rbac";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const creators = await this.prisma.userRole.count({ where: { orgId: null, role: { key: "creator" }, createdAt: { gte: from, lt: to } } });
    return [{ key: "creators_new", value: BigInt(creators) }];
  }
}
