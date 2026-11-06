import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by gigs: gigs published that day, sellers publishing their first gig, and the number of active gigs (a level: the value when the rollup ran). */
@Injectable()
export class GigsMetricsProvider implements MetricsProvider {
  readonly module = "gigs";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [published, firstPublished, active] = await Promise.all([
      this.prisma.gig.count({ where: { publishedAt: { gte: from, lt: to } } }),
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT g."sellerId")::bigint AS n
        FROM "gigs" g
        WHERE g."publishedAt" >= ${from} AND g."publishedAt" < ${to}
          AND NOT EXISTS (SELECT 1 FROM "gigs" e WHERE e."sellerId" = g."sellerId" AND e."publishedAt" < ${from})`,
      this.prisma.gig.count({ where: { status: "ACTIVE" } }),
    ]);
    return [
      { key: "gigs_published", value: BigInt(published) },
      { key: "first_gig_published", value: firstPublished[0]?.n ?? 0n },
      { key: "gigs_active", value: BigInt(active) },
    ];
  }
}
