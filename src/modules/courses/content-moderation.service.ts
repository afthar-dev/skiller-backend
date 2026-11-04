import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import type { Prisma } from "@prisma/client";
import { lockCourse } from "./course-lock";
import { ENROLMENT_ENDED, recomputeRating } from "./course-rating";
import type { ActionMeta } from "./course-state";
import { CoursePolicy } from "./course.policy";

export interface Hidden {
  id: string;
  hidden: boolean;
}

/**
 * Moderators (`course.review`) hide and restore learners' reviews, questions and answers. A reason is required and every change is audited.
 * Hidden content is out of every listing and, for reviews, out of the course rating. No reports module exists yet, so moderators find content themselves.
 */
@Injectable()
export class ContentModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: CoursePolicy,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async hideReview(id: string, reason: string, meta: ActionMeta): Promise<Hidden> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.review.findUnique({ where: { id }, select: { courseId: true } });
      if (!found) throw notFound("REVIEW_NOT_FOUND", "Review not found");
      await this.assertNotAuthor(tx, found.courseId, meta.actorId);
      await lockCourse(tx, found.courseId);
      const before = await tx.review.findUniqueOrThrow({ where: { id } });
      // Already hidden by a moderator: nothing to do. Hidden by the system (enrolment ended): a moderator's hide takes over, so reactivating the enrolment will not bring it back.
      if (before.hiddenAt && before.hiddenBy) return { id, hidden: true };
      await tx.review.update({ where: { id }, data: { hiddenAt: before.hiddenAt ?? this.clock.now(), hiddenBy: meta.actorId, hiddenReason: reason } });
      await recomputeRating(tx, found.courseId);
      await this.audit.record(tx, { ...meta, action: "course.review.hide", targetType: "review", targetId: id, before: { hidden: before.hiddenAt !== null }, after: { hidden: true, reason } });
      return { id, hidden: true };
    });
  }

  async unhideReview(id: string, reason: string, meta: ActionMeta): Promise<Hidden> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.review.findUnique({ where: { id }, select: { courseId: true, userId: true } });
      if (!found) throw notFound("REVIEW_NOT_FOUND", "Review not found");
      await this.assertNotAuthor(tx, found.courseId, meta.actorId);
      await lockCourse(tx, found.courseId);
      const before = await tx.review.findUniqueOrThrow({ where: { id } });
      if (!before.hiddenAt || !before.hiddenBy) return { id, hidden: before.hiddenAt !== null }; // visible, or hidden by the system alone
      const enrolled = (await tx.enrolment.count({ where: { courseId: found.courseId, userId: found.userId, revokedAt: null } })) > 0;
      // The learner's enrolment has ended: the moderator's hide is lifted, the system's stays.
      await tx.review.update({
        where: { id },
        data: enrolled ? { hiddenAt: null, hiddenBy: null, hiddenReason: null } : { hiddenBy: null, hiddenReason: ENROLMENT_ENDED },
      });
      await recomputeRating(tx, found.courseId);
      await this.audit.record(tx, { ...meta, action: "course.review.unhide", targetType: "review", targetId: id, before: { hidden: true }, after: { hidden: !enrolled, reason } });
      return { id, hidden: !enrolled };
    });
  }

  async hideQuestion(id: string, reason: string, meta: ActionMeta): Promise<Hidden> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.question.findUnique({ where: { id } });
      if (!before) throw notFound("QUESTION_NOT_FOUND", "Question not found");
      await this.assertNotAuthor(tx, before.courseId, meta.actorId);
      if (before.hiddenAt) return { id, hidden: true };
      await tx.question.update({ where: { id }, data: { hiddenAt: this.clock.now(), hiddenBy: meta.actorId, hiddenReason: reason } });
      await this.audit.record(tx, { ...meta, action: "course.question.hide", targetType: "question", targetId: id, before: { hidden: false }, after: { hidden: true, reason } });
      return { id, hidden: true };
    });
  }

  async unhideQuestion(id: string, reason: string, meta: ActionMeta): Promise<Hidden> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.question.findUnique({ where: { id } });
      if (!before) throw notFound("QUESTION_NOT_FOUND", "Question not found");
      await this.assertNotAuthor(tx, before.courseId, meta.actorId);
      if (!before.hiddenAt) return { id, hidden: false };
      await tx.question.update({ where: { id }, data: { hiddenAt: null, hiddenBy: null, hiddenReason: null } });
      await this.audit.record(tx, { ...meta, action: "course.question.unhide", targetType: "question", targetId: id, before: { hidden: true }, after: { hidden: false, reason } });
      return { id, hidden: false };
    });
  }

  async hideAnswer(id: string, reason: string, meta: ActionMeta): Promise<Hidden> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.answer.findUnique({ where: { id }, include: { question: { select: { courseId: true } } } });
      if (!before) throw notFound("ANSWER_NOT_FOUND", "Answer not found");
      await this.assertNotAuthor(tx, before.question.courseId, meta.actorId);
      if (before.hiddenAt) return { id, hidden: true };
      await tx.answer.update({ where: { id }, data: { hiddenAt: this.clock.now(), hiddenBy: meta.actorId, hiddenReason: reason } });
      await this.audit.record(tx, { ...meta, action: "course.answer.hide", targetType: "answer", targetId: id, before: { hidden: false }, after: { hidden: true, reason } });
      return { id, hidden: true };
    });
  }

  async unhideAnswer(id: string, reason: string, meta: ActionMeta): Promise<Hidden> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.answer.findUnique({ where: { id }, include: { question: { select: { courseId: true } } } });
      if (!before) throw notFound("ANSWER_NOT_FOUND", "Answer not found");
      await this.assertNotAuthor(tx, before.question.courseId, meta.actorId);
      if (!before.hiddenAt) return { id, hidden: false };
      await tx.answer.update({ where: { id }, data: { hiddenAt: null, hiddenBy: null, hiddenReason: null } });
      await this.audit.record(tx, { ...meta, action: "course.answer.unhide", targetType: "answer", targetId: id, before: { hidden: true }, after: { hidden: false, reason } });
      return { id, hidden: false };
    });
  }
  /** Whoever authors the course (creator, or an owner or instructor of the owning organization) may not moderate what learners say in it: same rule as for course decisions. */
  private async assertNotAuthor(tx: Prisma.TransactionClient, courseId: string, actorId: string): Promise<void> {
    const course = await tx.course.findUnique({ where: { id: courseId } });
    if (course && (course.createdById === actorId || (await this.policy.authorIds(course)).includes(actorId))) {
      throw new AppError("COURSE_REVIEW_SELF", 403, "You cannot moderate content in a course you author");
    }
  }
}

const notFound = (code: string, message: string) => new AppError(code, 404, message);
