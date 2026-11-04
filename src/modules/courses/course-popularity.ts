import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";

export const POPULARITY_WINDOW_DAYS = 30;

/** The "popular" sort: how many learners enrolled in the last 30 days, kept in a column so sorting never aggregates. */
@Injectable()
export class CoursePopularity {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Recomputes `enrolments30d` of every course in one UPDATE ... FROM aggregate (courses without recent enrolments go to 0; rows that already
   * hold the right number are not rewritten). Counts active enrolments only: a refund takes a course's popularity back. Returns the rows changed.
   */
  async refresh(): Promise<number> {
    const since = new Date(this.clock.now().getTime() - POPULARITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return this.prisma.$executeRaw`
      UPDATE "courses" c SET "enrolments30d" = COALESCE(a."n", 0)
      FROM "courses" c2
      LEFT JOIN (
        SELECT "courseId", COUNT(*)::int AS "n" FROM "enrolments" WHERE "revokedAt" IS NULL AND "createdAt" > ${since} GROUP BY "courseId"
      ) a ON a."courseId" = c2."id"
      WHERE c."id" = c2."id" AND c."enrolments30d" IS DISTINCT FROM COALESCE(a."n", 0)`;
  }
}
