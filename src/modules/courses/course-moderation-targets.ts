import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ModerationTargetRegistry } from "../moderation";
import { ContentModerationService } from "./content-moderation.service";
import { CoursePolicy } from "./course.policy";

/** Recorded as the actor on the course audit rows and as `hiddenBy` of content that member reports took down: the moderator who decided is in the moderation audit. */
export const REPORTS_ACTOR = "system:reports";
const REASON = "Reported by members";
const meta = { actorId: REPORTS_ACTOR };

/**
 * Course reviews and Q&A as reportable content: adapters over the Phase 3 hide / unhide functions, so hiding keeps the course rating right and every change is
 * audited. A removed item is hidden for good (a moderator can still unhide it); only members' reports reach here, the Phase 3 moderator endpoints stay as they were.
 */
@Injectable()
export class CourseModerationTargets implements OnModuleInit {
  constructor(
    private readonly registry: ModerationTargetRegistry,
    private readonly prisma: PrismaService,
    private readonly content: ContentModerationService,
    private readonly policy: CoursePolicy,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "COURSE_REVIEW",
      ownerOf: async (id) => (await this.prisma.review.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? null,
      hide: (tx, id) => this.hideReview(tx, id),
      remove: (tx, id) => this.hideReview(tx, id),
      restore: async (tx, id) => {
        const row = await tx.review.findUnique({ where: { id }, select: { hiddenAt: true, hiddenBy: true } });
        if (!row?.hiddenAt || !row.hiddenBy) return false;
        await this.content.unhideReviewIn(tx, id, REASON, meta);
        return true;
      },
      conflictsWith: async (id, actorId) => {
        const row = await this.prisma.review.findUnique({ where: { id }, select: { courseId: true } });
        return row ? this.authors(row.courseId, actorId) : false;
      },
      preview: async (id) => {
        const row = await this.prisma.review.findUnique({ where: { id }, select: { rating: true, body: true, hiddenAt: true } });
        return row ? { text: `${row.rating}/5 ${row.body ?? ""}`.trim(), status: row.hiddenAt ? "HIDDEN" : "VISIBLE" } : null;
      },
    });

    this.registry.register({
      type: "COURSE_QA",
      ownerOf: async (id) => (await this.qa(this.prisma, id))?.userId ?? null,
      hide: (tx, id) => this.hideQa(tx, id),
      remove: (tx, id) => this.hideQa(tx, id),
      restore: async (tx, id) => {
        const item = await this.qa(tx, id);
        if (!item?.hiddenAt) return false;
        if (item.kind === "question") await this.content.unhideQuestionIn(tx, id, REASON, meta);
        else await this.content.unhideAnswerIn(tx, id, REASON, meta);
        return true;
      },
      conflictsWith: async (id, actorId) => {
        const item = await this.qa(this.prisma, id);
        return item ? this.authors(item.courseId, actorId) : false;
      },
      preview: async (id) => {
        const item = await this.qa(this.prisma, id);
        return item ? { text: item.body, status: item.hiddenAt ? "HIDDEN" : "VISIBLE", kind: item.kind === "question" ? "QUESTION" : "ANSWER" } : null;
      },
    });
  }

  private async hideReview(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
    const row = await tx.review.findUnique({ where: { id }, select: { hiddenAt: true, hiddenBy: true } });
    if (!row || (row.hiddenAt && row.hiddenBy)) return false;
    await this.content.hideReviewIn(tx, id, REASON, meta);
    return true;
  }

  private async hideQa(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
    const item = await this.qa(tx, id);
    if (!item || item.hiddenAt) return false;
    if (item.kind === "question") await this.content.hideQuestionIn(tx, id, REASON, meta);
    else await this.content.hideAnswerIn(tx, id, REASON, meta);
    return true;
  }

  /** A question or an answer: the id says which. */
  private async qa(db: Pick<Prisma.TransactionClient, "question" | "answer">, id: string) {
    const question = await db.question.findUnique({ where: { id }, select: { userId: true, courseId: true, body: true, hiddenAt: true } });
    if (question) return { kind: "question" as const, ...question };
    const answer = await db.answer.findUnique({ where: { id }, select: { userId: true, body: true, hiddenAt: true, question: { select: { courseId: true } } } });
    return answer ? { kind: "answer" as const, userId: answer.userId, courseId: answer.question.courseId, body: answer.body, hiddenAt: answer.hiddenAt } : null;
  }

  private async authors(courseId: string, actorId: string): Promise<boolean> {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    return !!course && (course.createdById === actorId || (await this.policy.authorIds(course)).includes(actorId));
  }
}
