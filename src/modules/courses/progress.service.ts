import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { Prisma, type Lesson } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { CourseAccessRules } from "./course-access-rules";
import type { CourseProgressReader } from "./course-progress";
import { denied, notEnrolled } from "./learn-errors";

/** A lesson counts as watched at this share of its duration. */
export const WATCHED_COMPLETION_RATIO = 0.9;
/** At least this long between two heartbeats of one learner for one lesson. */
export const HEARTBEAT_MIN_INTERVAL_MS = 5000;
/** Watch time credited for a heartbeat is at most this many times the real time since the last one. */
export const WATCH_SPEED_FACTOR = 2;

export const COURSE_PROGRESS_RECOMPUTE_JOB = "courses.progress.recompute";

/**
 * SQL condition: the lesson can be done at all. A QUIZ lesson with no questions cannot be attempted, so it must not block a course
 * (live courses cannot reach that state any more; this keeps older ones from locking learners out). `alias` is a trusted constant.
 */
const playable = (alias: string) =>
  `NOT (${alias}."type" = 'QUIZ' AND NOT EXISTS (SELECT 1 FROM "quiz_questions" qq WHERE qq."quizId" = ${alias}."quizId"))`;

export type CompletionSource = "WATCHED" | "MANUAL" | "QUIZ";

export interface ProgressResult {
  positionSec: number;
  watchedSec: number;
  completed: boolean;
  courseProgressPct: number;
}

/**
 * What a learner has done in a course, as the server saw it. The client only ever reports a position; watch time, completion and the
 * course percentage are decided here. The same class runs in the API and in the worker (refund eligibility asks for the percentage there).
 */
@Injectable()
export class ProgressService implements CourseProgressReader {
  /** Courses with more active enrolments than this recompute in a background job instead of inside the author request. */
  inlineLimit = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: CourseAccessRules,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  /** Percentage of required lessons the learner has completed (the figure kept on their enrolment). */
  async completedRequiredPct(userId: string, courseId: string): Promise<number> {
    const e = await this.prisma.enrolment.findUnique({ where: { courseId_userId: { courseId, userId } }, select: { progressPct: true } });
    return e?.progressPct ?? 0;
  }

  /**
   * Video heartbeat: "the player is at `positionSec` now". Watch time grows by the distance moved forward, but never by more than
   * twice the wall-clock time since the previous accepted heartbeat (measured on the server clock), so seeking to the end earns almost
   * nothing and only real-time viewing reaches 90%. Backwards seeks and the first heartbeat add nothing.
   */
  async heartbeat(userId: string, lessonId: string, positionSec: number): Promise<ProgressResult> {
    const lesson = await this.trackable(userId, lessonId);
    if (lesson.type !== "VIDEO") throw new AppError("LESSON_NOT_VIDEO", 422, "Only video lessons report a watch position");
    const duration = lesson.durationSec;
    if (!duration || duration <= 0) throw new AppError("LESSON_NOT_VIDEO", 422, "This video has no known duration yet");

    return this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      await this.lockEnrolments(tx, lesson.courseId, { userId });
      await tx.lessonProgress.createMany({ data: [{ userId, lessonId, courseId: lesson.courseId }], skipDuplicates: true });
      // Row lock: concurrent heartbeats of one learner and lesson serialise, so they cannot both be credited for the same elapsed time.
      await tx.$queryRaw`SELECT 1 FROM "lesson_progress" WHERE "userId" = ${userId} AND "lessonId" = ${lessonId} FOR UPDATE`;
      const prev = await tx.lessonProgress.findUniqueOrThrow({ where: { userId_lessonId: { userId, lessonId } } });

      let elapsedMs = 0;
      if (prev.lastHeartbeatAt) {
        elapsedMs = now.getTime() - prev.lastHeartbeatAt.getTime();
        if (elapsedMs < HEARTBEAT_MIN_INTERVAL_MS) {
          const retryAfterSec = Math.max(1, Math.ceil((HEARTBEAT_MIN_INTERVAL_MS - elapsedMs) / 1000));
          throw new AppError("RATE_LIMITED", 429, "Too many requests", { retryAfterSec });
        }
      }

      const position = Math.min(positionSec, duration);
      const credit = prev.lastHeartbeatAt ? Math.min(Math.max(0, position - prev.positionSec), (WATCH_SPEED_FACTOR * elapsedMs) / 1000) : 0;
      const watched = Math.min(prev.watchedSec + credit, duration);
      await tx.lessonProgress.update({ where: { userId_lessonId: { userId, lessonId } }, data: { positionSec: position, watchedSec: watched, lastHeartbeatAt: now } });

      let completed = prev.completedAt !== null;
      if (!completed && watched >= WATCHED_COMPLETION_RATIO * duration) {
        await this.markLessonCompleted(tx, userId, lessonId, "WATCHED");
        completed = true;
      }
      return { positionSec: position, watchedSec: watched, completed, courseProgressPct: await this.pct(tx, userId, lesson.courseId) };
    });
  }

  /** "Mark complete" for articles and resources. Videos complete by watching; quizzes by passing. */
  async complete(userId: string, lessonId: string): Promise<ProgressResult> {
    const lesson = await this.trackable(userId, lessonId);
    if (lesson.type !== "ARTICLE" && lesson.type !== "RESOURCE") {
      throw new AppError("LESSON_NOT_COMPLETABLE", 422, "Only articles and resources are marked complete by hand; videos are completed by watching and quizzes by passing");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.markLessonCompleted(tx, userId, lessonId, "MANUAL");
      const row = await tx.lessonProgress.findUniqueOrThrow({ where: { userId_lessonId: { userId, lessonId } } });
      return { positionSec: row.positionSec, watchedSec: row.watchedSec, completed: true, courseProgressPct: await this.pct(tx, userId, lesson.courseId) };
    });
  }

  /**
   * Records a completed lesson (idempotent: the first completion time stays) and refreshes the learner's course percentage and
   * completion. The caller has already decided the learner earned it; the quiz feature calls this when an attempt passes.
   */
  async markLessonCompleted(tx: Prisma.TransactionClient, userId: string, lessonId: string, _source: CompletionSource): Promise<void> {
    const lesson = await tx.lesson.findUnique({ where: { id: lessonId }, select: { courseId: true } });
    if (!lesson) throw new AppError("LESSON_NOT_FOUND", 404, "Lesson not found");
    // The learner's enrolment row serialises everything that changes their progress: statements after the lock see what earlier holders committed.
    await this.lockEnrolments(tx, lesson.courseId, { userId });
    const now = this.clock.now();
    await tx.lessonProgress.createMany({ data: [{ userId, lessonId, courseId: lesson.courseId, completedAt: now }], skipDuplicates: true });
    await tx.lessonProgress.updateMany({ where: { userId, lessonId, completedAt: null }, data: { completedAt: now } });
    await this.refresh(tx, lesson.courseId, { userId });
  }

  /**
   * Recomputes every active learner's percentage after the required lessons of the course changed (added, removed, required toggled).
   * Learners who are now finished complete; learners already finished stay finished.
   */
  async recomputeCourse(tx: Prisma.TransactionClient, courseId: string): Promise<{ deferred: boolean }> {
    const active = await tx.enrolment.count({ where: { courseId, revokedAt: null } });
    if (active > this.inlineLimit) return { deferred: true };
    await this.lockEnrolments(tx, courseId, {});
    await this.refresh(tx, courseId, {});
    return { deferred: false };
  }

  /** After the editing transaction committed: queue the recompute of a large course (one job per course, repeated requests collapse into it). */
  async scheduleRecompute(courseId: string): Promise<void> {
    await this.maintenanceQueue.add(COURSE_PROGRESS_RECOMPUTE_JOB, { courseId }, { jobId: `courses-progress-recompute-${courseId}`, attempts: 3, removeOnComplete: true, removeOnFail: 100 });
  }

  /** The background job: the same recompute, in batches of enrolments so learners are never blocked for long. */
  async recomputeInBatches(courseId: string, batch = 500): Promise<number> {
    let after: string | undefined;
    let total = 0;
    for (;;) {
      const rows = await this.prisma.enrolment.findMany({ where: { courseId, revokedAt: null, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: batch });
      if (rows.length === 0) return total;
      after = rows[rows.length - 1].id;
      const ids = rows.map((r) => r.id);
      await this.prisma.$transaction(async (tx) => {
        await this.lockEnrolments(tx, courseId, { ids });
        await this.refresh(tx, courseId, { ids });
      });
      total += ids.length;
    }
  }

  /** A revoked enrolment came back (re-purchase): its percentage and completion may be stale from curriculum changes made meanwhile. */
  async refreshEnrolment(tx: Prisma.TransactionClient, courseId: string, userId: string): Promise<void> {
    await this.lockEnrolments(tx, courseId, { userId });
    await this.refresh(tx, courseId, { userId });
  }

  /** The learner's enrolment row, locked: everything that changes their progress (and quiz attempts) serialises on it. Returns whether an active enrolment exists. */
  async lockLearner(tx: Prisma.TransactionClient, courseId: string, userId: string): Promise<boolean> {
    await this.lockEnrolments(tx, courseId, { userId });
    return (await tx.enrolment.count({ where: { courseId, userId, revokedAt: null } })) > 0;
  }

  /** Row locks on active enrolments, always in id order so two lockers cannot deadlock. */
  private async lockEnrolments(tx: Prisma.TransactionClient, courseId: string, scope: { userId?: string; ids?: string[] }): Promise<void> {
    const filter = scope.userId ? Prisma.sql`AND "userId" = ${scope.userId}` : scope.ids ? Prisma.sql`AND "id" = ANY(${scope.ids})` : Prisma.empty;
    await tx.$queryRaw`SELECT "id" FROM "enrolments" WHERE "courseId" = ${courseId} AND "revokedAt" IS NULL ${filter} ORDER BY "id" FOR UPDATE`;
  }

  /** The learner's lesson, if they may write progress for it. Everything else is refused before anything is touched. */
  private async trackable(userId: string, lessonId: string): Promise<Lesson> {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId }, include: { course: true } });
    if (!lesson) throw new AppError("LESSON_NOT_FOUND", 404, "Lesson not found");
    const access = await this.rules.learnAccess(userId, lesson.course, lesson);
    if (!access) throw denied(lesson.course);
    if (!access.progress) throw notEnrolled();
    return lesson;
  }

  private async pct(tx: Prisma.TransactionClient, userId: string, courseId: string): Promise<number> {
    return (await tx.enrolment.findUnique({ where: { courseId_userId: { courseId, userId } }, select: { progressPct: true } }))?.progressPct ?? 0;
  }

  /**
   * One user (or, without `userId`, every active enrolment of the course): progressPct = floor(100 x completed required / required),
   * then enrolments that reached 100% with every quiz lesson done get `completedAt` and one `course.completed` event. The guarded
   * UPDATE sets completedAt only where it is still null, so concurrent or repeated runs emit the event once.
   */
  private async refresh(tx: Prisma.TransactionClient, courseId: string, scope: { userId?: string; ids?: string[] }): Promise<void> {
    const scopeFor = (a: string) => (scope.userId ? Prisma.sql`AND ${Prisma.raw(a)}."userId" = ${scope.userId}` : scope.ids ? Prisma.sql`AND ${Prisma.raw(a)}."id" = ANY(${scope.ids})` : Prisma.empty);
    const who = scopeFor("e");
    await tx.$executeRaw`
      UPDATE "enrolments" e SET "progressPct" = c.pct
      FROM (
        SELECT e2."id", CASE WHEN r.n = 0 THEN 0 ELSE floor(100.0 * (
          SELECT count(*) FROM "lesson_progress" p JOIN "lessons" l ON l."id" = p."lessonId"
          WHERE p."userId" = e2."userId" AND l."courseId" = e2."courseId" AND l."isRequired" AND p."completedAt" IS NOT NULL AND ${Prisma.raw(playable("l"))}) / r.n)::int END AS pct
        FROM "enrolments" e2, (SELECT count(*) AS n FROM "lessons" x WHERE x."courseId" = ${courseId} AND x."isRequired" AND ${Prisma.raw(playable("x"))}) r
        WHERE e2."courseId" = ${courseId} AND e2."revokedAt" IS NULL ${scopeFor("e2")}
      ) c
      WHERE e."id" = c."id" AND e."progressPct" IS DISTINCT FROM c.pct`;

    const finished = await tx.$queryRaw<{ userId: string }[]>`
      UPDATE "enrolments" e SET "completedAt" = ${this.clock.now()}
      WHERE e."courseId" = ${courseId} AND e."revokedAt" IS NULL AND e."completedAt" IS NULL AND e."progressPct" = 100 ${who}
        AND NOT EXISTS (
          SELECT 1 FROM "lessons" q WHERE q."courseId" = e."courseId" AND q."type" = 'QUIZ' AND ${Prisma.raw(playable("q"))}
            AND NOT EXISTS (SELECT 1 FROM "lesson_progress" p WHERE p."lessonId" = q."id" AND p."userId" = e."userId" AND p."completedAt" IS NOT NULL))
      RETURNING e."userId"`;
    for (const f of finished) await this.outbox.enqueue(tx, { type: "course.completed", userId: f.userId, courseId });
  }
}
