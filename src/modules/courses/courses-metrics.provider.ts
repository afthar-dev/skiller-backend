import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily rollup numbers owned by courses: enrolments, completions, certificates, and owners publishing their first course (approximate: a re-publish stamps a newer date). */
@Injectable()
export class CoursesMetricsProvider implements MetricsProvider {
  readonly module = "courses";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [enrolments, completions, certificates, firstPublished] = await Promise.all([
      this.prisma.enrolment.count({ where: { createdAt: { gte: from, lt: to } } }),
      this.prisma.enrolment.count({ where: { completedAt: { gte: from, lt: to } } }),
      this.prisma.certificate.count({ where: { issuedAt: { gte: from, lt: to } } }),
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT c."ownerType"::text || ':' || c."ownerId")::bigint AS n
        FROM "courses" c
        WHERE c."publishedAt" >= ${from} AND c."publishedAt" < ${to}
          AND NOT EXISTS (
            SELECT 1 FROM "courses" e
            WHERE e."ownerType" = c."ownerType" AND e."ownerId" = c."ownerId" AND e."publishedAt" < ${from})`,
    ]);
    return [
      { key: "enrolments", value: BigInt(enrolments) },
      { key: "course_completions", value: BigInt(completions) },
      { key: "certificates_issued", value: BigInt(certificates) },
      { key: "first_course_published", value: firstPublished[0]?.n ?? 0n },
    ];
  }
}
