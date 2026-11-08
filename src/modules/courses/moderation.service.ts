import { Inject, Injectable } from "@nestjs/common";
import type { Course, Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { CourseNotifier } from "./course-notifier";
import { lockCourse } from "./course-lock";
import { stateInvalid, type ActionMeta } from "./course-state";
import { toCourseView, type CourseView } from "./course-view";
import { CoursePolicy, courseNotFound } from "./course.policy";
import { lockOwnerPublishing, PublishingService } from "./publishing.service";

const encodeCursor = (c: { submittedAt: Date | null; id: string }) => Buffer.from(`${c.submittedAt?.toISOString() ?? ""}|${c.id}`).toString("base64url");
function decodeCursor(raw: string): { submittedAt: Date | null; id: string } {
  const [at, id] = Buffer.from(raw, "base64url").toString().split("|");
  const submittedAt = at ? new Date(at) : null;
  if (!id || (submittedAt && Number.isNaN(submittedAt.getTime()))) throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { cursor: ["invalid"] } });
  return { submittedAt, id };
}

/** The moderator's side of the lifecycle. Callers hold `course.review`; every action is audited and tells the authors. */
@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publishing: PublishingService,
    private readonly policy: CoursePolicy,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifier: CourseNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Courses waiting for a decision, longest waiting first (courses without a submission time, which only legacy rows have, come first). */
  async queue(page: PageQuery) {
    const after = page.cursor ? decodeCursor(page.cursor) : null;
    const where: Prisma.CourseWhereInput = { status: "IN_REVIEW" };
    if (after) {
      where.OR = after.submittedAt
        ? [{ submittedAt: { gt: after.submittedAt } }, { submittedAt: after.submittedAt, id: { gt: after.id } }]
        : [{ submittedAt: null, id: { gt: after.id } }, { submittedAt: { not: null } }];
    }
    const rows = await this.prisma.course.findMany({ where, orderBy: [{ submittedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: page.limit + 1 });
    const items = rows.slice(0, page.limit);
    return { items: items.map(toCourseView), nextCursor: rows.length > page.limit ? encodeCursor(items[items.length - 1]) : null };
  }

  /** IN_REVIEW -> PUBLISHED. The publish checks run again (the course and the owner's plan may have changed while queued). */
  async approve(id: string, meta: ActionMeta): Promise<CourseView> {
    // Read before the transaction (a cache miss is a second pooled connection while the transaction holds the first). A course that does not exist is refused inside it.
    const owner = await this.prisma.course.findUnique({ where: { id }, select: { ownerType: true, ownerId: true } });
    const limit = owner ? await this.publishing.publishLimit(owner) : null;
    const row = await this.prisma.$transaction(async (tx) => {
      const course = await this.lockedInReview(tx, id, meta.actorId);
      await lockOwnerPublishing(tx, course);
      await this.publishing.assertPublishable(tx, course, limit);
      const now = this.clock.now();
      const updated = await tx.course.update({
        where: { id },
        data: { status: "PUBLISHED", publishedAt: course.publishedAt ?? now, slugLockedAt: course.slugLockedAt ?? now, rejectionReason: null },
      });
      await this.outbox.enqueue(tx, { type: "course.published", courseId: id, ownerType: updated.ownerType, ownerId: updated.ownerId, slug: updated.slug, title: updated.title });
      await this.audit.record(tx, { ...meta, action: "course.approve", targetType: "course", targetId: id, before: { status: course.status }, after: { status: updated.status } });
      return updated;
    });
    await this.notifier.notifyAuthors(row, { type: "course.approved", title: "Your course is published", body: `${row.title} was approved and is now live.`, link: `/studio/courses/${id}` });
    return toCourseView(row);
  }

  /** IN_REVIEW -> DRAFT with the moderator's reason; the author fixes it and submits again. */
  async reject(id: string, reason: string, meta: ActionMeta): Promise<CourseView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const course = await this.lockedInReview(tx, id, meta.actorId);
      const updated = await tx.course.update({ where: { id }, data: { status: "DRAFT", rejectionReason: reason } });
      await this.audit.record(tx, { ...meta, action: "course.reject", targetType: "course", targetId: id, before: { status: course.status }, after: { status: updated.status, reason } });
      return updated;
    });
    await this.notifier.notifyAuthors(row, { type: "course.rejected", title: "Your course needs changes", body: `${row.title} was not approved: ${reason}`, link: `/studio/courses/${id}` });
    return toCourseView(row);
  }

  /** Hides a published course from the catalog and stops new sales; learners who are enrolled keep their access. */
  async flag(id: string, reason: string, meta: ActionMeta): Promise<CourseView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const course = await this.locked(tx, id, meta.actorId);
      if (course.status !== "PUBLISHED") throw stateInvalid("Only a published course can be flagged");
      if (course.flaggedAt) throw new AppError("COURSE_ALREADY_FLAGGED", 409, "This course is already flagged");
      const updated = await tx.course.update({ where: { id }, data: { flaggedAt: this.clock.now(), flagReason: reason } });
      await this.audit.record(tx, { ...meta, action: "course.flag", targetType: "course", targetId: id, before: { flagged: false }, after: { flagged: true, reason } });
      return updated;
    });
    await this.notifier.notifyAuthors(row, { type: "course.flagged", title: "Your course was hidden", body: `${row.title} was taken off the catalog by a moderator: ${reason}`, link: `/studio/courses/${id}` });
    return toCourseView(row);
  }

  async unflag(id: string, reason: string, meta: ActionMeta): Promise<CourseView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const course = await this.locked(tx, id, meta.actorId);
      if (!course.flaggedAt) throw new AppError("COURSE_NOT_FLAGGED", 409, "This course is not flagged");
      const updated = await tx.course.update({ where: { id }, data: { flaggedAt: null, flagReason: null } });
      await this.audit.record(tx, { ...meta, action: "course.unflag", targetType: "course", targetId: id, before: { flagged: true, reason: course.flagReason }, after: { flagged: false, reason } });
      return updated;
    });
    await this.notifier.notifyAuthors(row, { type: "course.unflagged", title: "Your course is visible again", body: `${row.title} is back on the catalog: ${reason}`, link: `/studio/courses/${id}` });
    return toCourseView(row);
  }

  /** Loads the course under its lock. Whoever authors it (creator, or an owner or instructor of the owning organization) may not moderate it. */
  private async locked(tx: Prisma.TransactionClient, id: string, actorId: string): Promise<Course> {
    await lockCourse(tx, id);
    const course = await tx.course.findUnique({ where: { id } });
    if (!course) throw courseNotFound();
    if (course.createdById === actorId || (await this.policy.authorIds(course)).includes(actorId)) {
      throw new AppError("COURSE_REVIEW_SELF", 403, "You cannot review a course you author");
    }
    return course;
  }

  private async lockedInReview(tx: Prisma.TransactionClient, id: string, actorId: string): Promise<Course> {
    const course = await this.locked(tx, id, actorId);
    if (course.status !== "IN_REVIEW") throw stateInvalid("Only a course in review can be decided");
    return course;
  }
}
