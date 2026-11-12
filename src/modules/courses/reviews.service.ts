import { Inject, Injectable } from "@nestjs/common";
import type { Course, Review } from "@prisma/client";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { ProfilesService } from "../users";
import { CourseAccessRules } from "./course-access-rules";
import { lockCourse } from "./course-lock";
import { CourseNotifier } from "./course-notifier";
import { MIN_RATINGS_TO_SHOW, recomputeRating } from "./course-rating";
import { CoursePolicy, courseNotFound } from "./course.policy";
import { sanitizePlainText } from "./plain-text";

export const REVIEW_BODY_MAX = 2000;
export const REVIEWS_PER_HOUR = 10;
export const REVIEW_REPLIES_PER_HOUR = 60;

export const reviewNotAllowed = (message: string) => new AppError("REVIEW_NOT_ALLOWED", 403, message);
const reviewNotFound = () => new AppError("REVIEW_NOT_FOUND", 404, "Review not found");

interface Author {
  handle: string | null;
  displayName: string;
  avatarAssetId: string | null;
  avatarUrl: string | null;
}

const ANONYMOUS: Author = { handle: null, displayName: "Learner", avatarAssetId: null, avatarUrl: null };

/** What a reader of the course page sees of a review. The reviewer's user id is not part of it. */
const toPublic = (r: Review, author: Author | undefined) => ({
  id: r.id,
  rating: r.rating,
  body: r.body,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  reply: r.reply,
  repliedAt: r.repliedAt?.toISOString() ?? null,
  author: author ?? ANONYMOUS,
});

/** What a reviewer sees of their own review: also whether it is currently hidden from others. */
const toMine = (r: Review) => ({
  id: r.id,
  courseId: r.courseId,
  rating: r.rating,
  body: r.body,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  reply: r.reply,
  repliedAt: r.repliedAt?.toISOString() ?? null,
  hidden: r.hiddenAt !== null,
});

/** One review per learner per course; the course rating follows every change in the same transaction. */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: CourseAccessRules,
    private readonly policy: CoursePolicy,
    private readonly profiles: ProfilesService,
    private readonly notifier: CourseNotifier,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Reviews of a published course, newest first; hidden ones are not part of it. The summary follows the "3 ratings" rule. */
  async list(slug: string, page: PageQuery) {
    const course = await this.publicCourse(slug);
    const rows = await this.prisma.review.findMany({
      where: { courseId: course.id, hiddenAt: null, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    const authors = await this.profiles.summaries(items.map((r) => r.userId));
    return {
      items: items.map((r) => {
        const a = authors.get(r.userId);
        return toPublic(r, a ? { handle: a.handle, displayName: a.displayName, avatarAssetId: a.avatarAssetId, avatarUrl: a.avatarUrl } : undefined);
      }),
      nextCursor,
      summary: {
        ratingAvg: course.ratingCount >= MIN_RATINGS_TO_SHOW && course.ratingAvg !== null ? Number(course.ratingAvg.toString()) : null,
        ratingCount: course.ratingCount,
      },
    };
  }

  async mine(userId: string, slug: string) {
    const course = await this.prisma.course.findUnique({ where: { slug }, select: { id: true } });
    const review = course && (await this.prisma.review.findUnique({ where: { courseId_userId: { courseId: course.id, userId } } }));
    if (!review) throw reviewNotFound();
    return toMine(review);
  }

  /** Creates or updates the learner's review. Authors and learners whose enrolment ended cannot review. */
  async upsert(userId: string, slug: string, input: { rating: number; body: string | null }) {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course) throw courseNotFound();
    const relation = await this.rules.buyerRelation(userId, course);
    if (relation === "OWN" || relation === "ORG_AUTHOR") throw reviewNotAllowed("Authors cannot review their own course");
    const access = await this.rules.learnAccess(userId, course);
    if (access?.via !== "ENROLLED") {
      if (course.status !== "PUBLISHED" || course.flaggedAt) throw courseNotFound();
      throw reviewNotAllowed("Only learners enrolled in this course can review it");
    }
    await consumeRateLimit(this.redis, `review:write:${userId}`, REVIEWS_PER_HOUR, 3600);

    const body = input.body === null ? null : sanitizePlainText(input.body, REVIEW_BODY_MAX) || null;
    const { review, created } = await this.prisma.$transaction(async (tx) => {
      await lockCourse(tx, course.id);
      // The enrolment may have ended while this request waited for the lock.
      if (!(await tx.enrolment.findFirst({ where: { courseId: course.id, userId, revokedAt: null }, select: { id: true } }))) {
        throw reviewNotAllowed("Only learners enrolled in this course can review it");
      }
      const existing = await tx.review.findUnique({ where: { courseId_userId: { courseId: course.id, userId } } });
      const row = existing
        ? await tx.review.update({ where: { id: existing.id }, data: { rating: input.rating, body } })
        : await tx.review.create({ data: { courseId: course.id, userId, rating: input.rating, body } });
      await recomputeRating(tx, course.id);
      return { review: row, created: existing === null };
    });
    if (created) {
      await this.notifier.notifyAuthorsOfActivity(course, "review", userId, {
        type: "course.review",
        title: "New review on your course",
        body: `${course.title} has a new review.`,
        link: `/studio/courses/${course.id}/reviews`,
      });
    }
    return toMine(review);
  }

  /** An author answers a review: once (editing allowed). The learner hears about the first reply only. */
  async reply(user: { id: string }, reviewId: string, rawBody: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId }, include: { course: true } });
    if (!review || review.hiddenAt || !(await this.policy.canAuthor(user, review.course))) throw reviewNotFound();
    const reply = sanitizePlainText(rawBody, REVIEW_BODY_MAX);
    if (!reply) throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { body: ["required"] } });
    await consumeRateLimit(this.redis, `review:reply:${user.id}`, REVIEW_REPLIES_PER_HOUR, 3600);

    const first = review.repliedAt === null;
    const updated = await this.prisma.review.update({ where: { id: reviewId }, data: { reply, repliedAt: review.repliedAt ?? this.clock.now(), repliedById: user.id } });
    if (first) {
      await this.notifier.notifyUser(review.userId, {
        type: "course.review_reply",
        title: "The instructor replied to your review",
        body: `${review.course.title}: ${reply.slice(0, 140)}`,
        link: `/courses/${review.course.slug}/reviews`,
        data: { courseId: review.courseId, reviewId },
      });
    }
    return toPublic(updated, undefined);
  }

  private async publicCourse(slug: string): Promise<Course> {
    const course = await this.prisma.course.findUnique({ where: { slug } });
    if (!course || course.status !== "PUBLISHED" || course.flaggedAt) throw courseNotFound();
    return course;
  }
}
