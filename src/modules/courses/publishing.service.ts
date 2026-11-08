import { Inject, Injectable } from "@nestjs/common";
import type { Course, Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { EntitlementsService, type PlanLimits } from "../billing";
import { MediaService } from "../media";
import { CourseNotifier } from "./course-notifier";
import { lockCourse } from "./course-lock";
import { stateInvalid, type ActionMeta } from "./course-state";
import { toCourseView, type CourseView } from "./course-view";
import { CoursePolicy, courseNotFound } from "./course.policy";

export interface PublishReason {
  code: "NO_SECTIONS" | "NO_REQUIRED_LESSON" | "VIDEO_NOT_READY" | "QUIZ_EMPTY" | "NO_THUMBNAIL";
  message: string;
}

/** Serialises the publish decisions of one owner (approvals racing each other must not overshoot the plan limit). */
export const lockOwnerPublishing = (tx: Prisma.TransactionClient, course: Pick<Course, "ownerType" | "ownerId">) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`course-publish:${course.ownerType}:${course.ownerId}`}))`;

/** Submitting for review and archiving: the author's side of the lifecycle. The moderator's side is ModerationService. */
@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CoursePolicy,
    private readonly media: MediaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifier: CourseNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** DRAFT -> IN_REVIEW. Refused with every reason the course is incomplete, or when the owner's plan has no free published slot. */
  async submit(user: { id: string }, id: string, meta: Omit<ActionMeta, "actorId"> = {}): Promise<CourseView> {
    const loaded = await this.policy.loadForAuthor(user, id);
    // Read before the transaction: on a cache miss this is a database read, and inside it needs a second pooled connection (see EntitlementsService.enforce).
    const limit = await this.publishLimit(loaded);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockCourse(tx, id);
      const course = await tx.course.findUnique({ where: { id } });
      if (!course) throw courseNotFound();
      if (course.status !== "DRAFT") throw stateInvalid("Only a draft can be submitted for review");
      await this.assertPublishable(tx, course, limit);
      const row = await tx.course.update({ where: { id }, data: { status: "IN_REVIEW", submittedAt: this.clock.now(), rejectionReason: null } });
      await this.audit.record(tx, { actorId: user.id, action: "course.submit", targetType: "course", targetId: id, before: { status: course.status }, after: { status: row.status }, ...meta });
      return row;
    });
    await this.notifier.notifyModerators(updated, user.id);
    return toCourseView(updated);
  }

  /** IN_REVIEW -> DRAFT: the author takes the course back (to edit it) before a moderator decides. */
  async withdraw(user: { id: string }, id: string, meta: Omit<ActionMeta, "actorId"> = {}): Promise<CourseView> {
    await this.policy.loadForAuthor(user, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockCourse(tx, id);
      const course = await tx.course.findUnique({ where: { id } });
      if (!course) throw courseNotFound();
      if (course.status !== "IN_REVIEW") throw stateInvalid("Only a course in review can be withdrawn");
      const row = await tx.course.update({ where: { id }, data: { status: "DRAFT" } });
      await this.audit.record(tx, { actorId: user.id, action: "course.withdraw", targetType: "course", targetId: id, before: { status: course.status }, after: { status: row.status }, ...meta });
      return row;
    });
    return toCourseView(updated);
  }

  /** PUBLISHED -> ARCHIVED: gone from the catalog and not for sale; learners who are enrolled keep their access. */
  async archive(user: { id: string }, id: string, meta: Omit<ActionMeta, "actorId"> = {}): Promise<CourseView> {
    await this.policy.loadForAuthor(user, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockCourse(tx, id);
      const course = await tx.course.findUnique({ where: { id } });
      if (!course) throw courseNotFound();
      if (course.status !== "PUBLISHED") throw stateInvalid("Only a published course can be archived");
      const row = await tx.course.update({ where: { id }, data: { status: "ARCHIVED" } });
      await this.audit.record(tx, { actorId: user.id, action: "course.archive", targetType: "course", targetId: id, before: { status: course.status }, after: { status: row.status }, ...meta });
      return row;
    });
    return toCourseView(updated);
  }

  /**
   * The checks for a course to go live, run at submission and again at approval (the course may have changed while queued).
   * Content problems come first as COURSE_NOT_PUBLISHABLE; then the plan: published courses of the owner (flagged ones count,
   * archived ones do not) plus this one must fit `max_published_courses`.
   */
  async assertPublishable(db: Prisma.TransactionClient, course: Course, limit: PlanLimits["max_published_courses"]): Promise<void> {
    const reasons = await this.reasonsNotPublishable(db, course);
    if (reasons.length > 0) throw new AppError("COURSE_NOT_PUBLISHABLE", 422, "This course is not ready to be published", { reasons });
    const published = await db.course.count({ where: { ownerType: course.ownerType, ownerId: course.ownerId, status: "PUBLISHED", id: { not: course.id } } });
    this.entitlements.enforce("max_published_courses", limit, published + 1);
  }

  /**
   * The owner's `max_published_courses`, for assertPublishable. Read it BEFORE opening the transaction that calls assertPublishable (a
   * course never changes owner): inside it, a cache miss needs a second pooled connection and parallel callers starve the pool (P2024).
   */
  publishLimit(course: Pick<Course, "ownerType" | "ownerId">): Promise<PlanLimits["max_published_courses"]> {
    return this.entitlements.limit({ ownerType: course.ownerType, ownerId: course.ownerId }, "max_published_courses");
  }

  private async reasonsNotPublishable(db: Prisma.TransactionClient, course: Course): Promise<PublishReason[]> {
    const [sections, lessons] = await Promise.all([
      db.courseSection.count({ where: { courseId: course.id } }),
      db.lesson.findMany({ where: { courseId: course.id }, select: { type: true, isRequired: true, videoAssetId: true, quizId: true } }),
    ]);
    const reasons: PublishReason[] = [];
    if (sections === 0) reasons.push({ code: "NO_SECTIONS", message: "Add at least one section" });
    if (!lessons.some((l) => l.isRequired)) reasons.push({ code: "NO_REQUIRED_LESSON", message: "Add at least one required lesson" });
    const videos = lessons.filter((l) => l.type === "VIDEO");
    if (videos.length > 0) {
      const statuses = await this.media.assetStatuses(videos.flatMap((l) => (l.videoAssetId ? [l.videoAssetId] : [])), db);
      const notReady = videos.filter((l) => !l.videoAssetId || statuses.get(l.videoAssetId) !== "READY").length;
      if (notReady > 0) reasons.push({ code: "VIDEO_NOT_READY", message: `${notReady} video lesson${notReady === 1 ? " has" : "s have"} no video that is ready to play` });
    }
    const quizLessons = lessons.filter((l) => l.type === "QUIZ");
    if (quizLessons.length > 0) {
      const filled = await db.quiz.findMany({ where: { id: { in: quizLessons.flatMap((l) => (l.quizId ? [l.quizId] : [])) }, questions: { some: {} } }, select: { id: true } });
      const withQuestions = new Set(filled.map((q) => q.id));
      const empty = quizLessons.filter((l) => !l.quizId || !withQuestions.has(l.quizId)).length;
      if (empty > 0) reasons.push({ code: "QUIZ_EMPTY", message: `${empty} quiz lesson${empty === 1 ? " has" : "s have"} no questions` });
    }
    if (!course.thumbnailAssetId) reasons.push({ code: "NO_THUMBNAIL", message: "Add a thumbnail" });
    return reasons;
  }
}
