import { Inject, Injectable } from "@nestjs/common";
import type { EnrolmentSource } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { BillingReports, EntitlementsService, addDays, istDateOf, istDayRange, toApi } from "../billing";
import { CoursePolicy } from "./course.policy";
import { MIN_RATINGS_TO_SHOW } from "./course-rating";

export const ANALYTICS_MAX_DAYS = 366;
export const ANALYTICS_DEFAULT_DAYS = 30;
const SOURCES: EnrolmentSource[] = ["FREE", "PURCHASE", "ORG_SEAT"];
const DAY_MS = 86_400_000;

const badRange = (message: string) => new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { range: [message] } });

export interface AnalyticsRange {
  /** Inclusive IST calendar days. */
  from: string;
  to: string;
}

export interface LessonAnalytics {
  lessonId: string;
  title: string;
  type: string;
  completedCount: number;
  completionShare: number;
  watchSeconds: number;
}

export interface CourseAnalytics {
  courseId: string;
  range: AnalyticsRange;
  enrolments: { total: number; byDay: Array<{ date: string; FREE: number; PURCHASE: number; ORG_SEAT: number; total: number }> };
  activeEnrolments: number;
  completedEnrolments: number;
  completionRate: number;
  rating: { avg: number | null; count: number };
  revenue: { currency: "INR"; soldPaise: string; refundedPaise: string; netPaise: string };
  upgradeRequired: boolean;
  lessons?: LessonAnalytics[];
}

/**
 * Creator analytics for one course. Everything is aggregated in SQL (no per-learner loops). Days are IST calendar days; the range is
 * inclusive on both ends and at most 366 days. Enrolments and revenue follow the range; completion rate, drop-off and watch time describe
 * the course as it stands now (learners with a live enrolment), because progress rows carry no history.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CoursePolicy,
    private readonly entitlements: EntitlementsService,
    private readonly reports: BillingReports,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async forCourse(user: { id: string }, courseId: string, query: { from?: string; to?: string }): Promise<CourseAnalytics> {
    const course = await this.policy.loadForAuthor(user, courseId);
    const range = this.range(query);
    const start = istDayRange(range.from).from;
    const end = istDayRange(range.to).to;

    const level = await this.entitlements.limit({ ownerType: course.ownerType, ownerId: course.ownerId }, "analytics_level");
    const detailed = level === "standard" || level === "advanced";

    const [byDay, totals, revenue, lessons] = await Promise.all([
      this.enrolmentsByDay(courseId, start, end, range),
      this.activeAndCompleted(courseId),
      this.reports.sellerRevenueForItem("COURSE", courseId, start, end),
      detailed ? this.lessons(courseId) : Promise.resolve(null),
    ]);

    const result: CourseAnalytics = {
      courseId,
      range,
      enrolments: { total: byDay.reduce((n, d) => n + d.total, 0), byDay },
      activeEnrolments: totals.active,
      completedEnrolments: totals.completed,
      completionRate: totals.active === 0 ? 0 : totals.completed / totals.active,
      rating: { avg: course.ratingCount >= MIN_RATINGS_TO_SHOW && course.ratingAvg !== null ? Number(course.ratingAvg.toString()) : null, count: course.ratingCount },
      revenue: { currency: "INR", soldPaise: toApi(revenue.soldPaise), refundedPaise: toApi(revenue.refundedPaise), netPaise: toApi(revenue.netPaise) },
      upgradeRequired: !detailed,
    };
    if (lessons) {
      result.lessons = lessons.map((l) => ({ ...l, completionShare: totals.active === 0 ? 0 : l.completedCount / totals.active }));
    }
    return result;
  }

  private range(query: { from?: string; to?: string }): AnalyticsRange {
    const to = query.to ?? istDateOf(this.clock.now());
    const from = query.from ?? addDays(to, -(ANALYTICS_DEFAULT_DAYS - 1));
    let days: number;
    try {
      days = Math.round((istDayRange(to).from.getTime() - istDayRange(from).from.getTime()) / DAY_MS) + 1;
    } catch {
      throw badRange("from and to must be real calendar dates (YYYY-MM-DD)");
    }
    if (days < 1) throw badRange("from must not be after to");
    if (days > ANALYTICS_MAX_DAYS) throw badRange(`the range can cover at most ${ANALYTICS_MAX_DAYS} days`);
    return { from, to };
  }

  private async enrolmentsByDay(courseId: string, start: Date, end: Date, range: AnalyticsRange) {
    const rows = await this.prisma.$queryRaw<{ day: string; source: EnrolmentSource; n: number }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, "source"::text AS source, COUNT(*)::int AS n
      FROM "enrolments"
      WHERE "courseId" = ${courseId} AND "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1, 2
    `;
    const days = new Map<string, { date: string; FREE: number; PURCHASE: number; ORG_SEAT: number; total: number }>();
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.set(d, { date: d, FREE: 0, PURCHASE: 0, ORG_SEAT: 0, total: 0 });
    for (const r of rows) {
      const day = days.get(r.day);
      if (!day || !SOURCES.includes(r.source)) continue;
      day[r.source] = r.n;
      day.total += r.n;
    }
    return [...days.values()];
  }

  private async activeAndCompleted(courseId: string): Promise<{ active: number; completed: number }> {
    const rows = await this.prisma.$queryRaw<{ active: number; completed: number }[]>`
      SELECT COUNT(*)::int AS active, (COUNT(*) FILTER (WHERE "completedAt" IS NOT NULL))::int AS completed
      FROM "enrolments" WHERE "courseId" = ${courseId} AND "revokedAt" IS NULL
    `;
    return { active: rows[0]?.active ?? 0, completed: rows[0]?.completed ?? 0 };
  }

  /** Curriculum order; progress counts only learners who hold a live enrolment (refunded learners' rows are kept but hidden). */
  private async lessons(courseId: string): Promise<Array<Omit<LessonAnalytics, "completionShare">>> {
    const rows = await this.prisma.$queryRaw<{ id: string; title: string; type: string; completed: number; watched: number }[]>`
      SELECT l."id", l."title", l."type"::text AS type, COALESCE(p.completed, 0)::int AS completed, COALESCE(p.watched, 0)::float8 AS watched
      FROM "lessons" l
      JOIN "course_sections" s ON s."id" = l."sectionId"
      LEFT JOIN (
        SELECT lp."lessonId", COUNT(lp."completedAt") AS completed, SUM(lp."watchedSec") AS watched
        FROM "lesson_progress" lp
        JOIN "enrolments" e ON e."courseId" = lp."courseId" AND e."userId" = lp."userId" AND e."revokedAt" IS NULL
        WHERE lp."courseId" = ${courseId}
        GROUP BY lp."lessonId"
      ) p ON p."lessonId" = l."id"
      WHERE l."courseId" = ${courseId}
      ORDER BY s."position", l."position", l."id"
    `;
    return rows.map((r) => ({ lessonId: r.id, title: r.title, type: r.type, completedCount: r.completed, watchSeconds: Math.round(r.watched) }));
  }
}
