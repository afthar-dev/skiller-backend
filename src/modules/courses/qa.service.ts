import { Inject, Injectable } from "@nestjs/common";
import type { Answer, Course, Lesson, Question } from "@prisma/client";
import type { Redis } from "ioredis";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { ProfilesService } from "../users";
import { CourseAccessRules, type LearnAccess } from "./course-access-rules";
import { CourseNotifier } from "./course-notifier";
import { denied } from "./learn-errors";
import { sanitizePlainText } from "./plain-text";

export const QUESTION_BODY_MAX = 2000;
export const ANSWER_BODY_MAX = 5000;
export const QUESTIONS_PER_HOUR = 20;
export const ANSWERS_PER_HOUR = 60;

interface Author {
  handle: string | null;
  displayName: string;
  avatarAssetId: string | null;
}

const ANONYMOUS: Author = { handle: null, displayName: "Learner", avatarAssetId: null };

const questionNotFound = () => new AppError("QUESTION_NOT_FOUND", 404, "Question not found");
const notAllowedToPost = () => new AppError("QA_NOT_ALLOWED", 403, "Enrol in this course to take part in the discussion");

type LessonWithCourse = Lesson & { course: Course };

/** Lesson Q&A. Reading follows lesson access (a free-preview lesson's discussion is open to its viewers); posting needs an enrolment or authorship. */
@Injectable()
export class QaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: CourseAccessRules,
    private readonly profiles: ProfilesService,
    private readonly notifier: CourseNotifier,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async questions(userId: string, lessonId: string, page: PageQuery) {
    const lesson = await this.lessonFor(lessonId);
    await this.readAccess(userId, lesson);
    const rows = await this.prisma.question.findMany({
      where: { lessonId, hiddenAt: null, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    const counts = new Map(
      (await this.prisma.answer.groupBy({ by: ["questionId"], where: { questionId: { in: items.map((q) => q.id) }, hiddenAt: null }, _count: { _all: true } })).map((g) => [g.questionId, g._count._all]),
    );
    const authors = await this.authorsOf(items.map((q) => q.userId));
    return { items: items.map((q) => this.questionView(q, authors, counts.get(q.id) ?? 0)), nextCursor };
  }

  async ask(userId: string, lessonId: string, rawBody: string) {
    const lesson = await this.lessonFor(lessonId);
    await this.postAccess(userId, lesson);
    const body = this.requireText(rawBody, QUESTION_BODY_MAX);
    await consumeRateLimit(this.redis, `qa:question:${userId}`, QUESTIONS_PER_HOUR, 3600);

    const q = await this.prisma.question.create({ data: { lessonId, courseId: lesson.courseId, userId, body } });
    await this.notifier.notifyAuthorsOfActivity(lesson.course, "question", userId, {
      type: "course.question",
      title: "New question in your course",
      body: `A learner asked a question in ${lesson.course.title}: ${lesson.title}.`,
      link: `/studio/courses/${lesson.courseId}/questions`,
    });
    return this.questionView(q, await this.authorsOf([userId]), 0);
  }

  /** Visible answers of a visible question, newest first. */
  async answers(userId: string, questionId: string, page: PageQuery) {
    const { lesson } = await this.visibleQuestion(questionId);
    await this.readAccess(userId, lesson);
    const rows = await this.prisma.answer.findMany({
      where: { questionId, hiddenAt: null, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    const authors = await this.authorsOf(items.map((a) => a.userId));
    return { items: items.map((a) => this.answerView(a, authors)), nextCursor };
  }

  async answer(userId: string, questionId: string, rawBody: string) {
    const { question, lesson } = await this.visibleQuestion(questionId);
    const access = await this.postAccess(userId, lesson);
    const body = this.requireText(rawBody, ANSWER_BODY_MAX);
    await consumeRateLimit(this.redis, `qa:answer:${userId}`, ANSWERS_PER_HOUR, 3600);

    const a = await this.prisma.answer.create({ data: { questionId, userId, body, isInstructor: access.via === "AUTHOR" } });
    if (question.userId !== userId) {
      await this.notifier.notifyUser(question.userId, {
        type: "course.answer",
        title: "Your question was answered",
        body: `${lesson.course.title}: ${body.slice(0, 140)}`,
        link: `/learn/${lesson.course.slug}/lessons/${lesson.id}`,
        data: { courseId: lesson.courseId, lessonId: lesson.id, questionId, answerId: a.id },
      });
    }
    return this.answerView(a, await this.authorsOf([userId]));
  }

  private async lessonFor(lessonId: string): Promise<LessonWithCourse> {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId }, include: { course: true } });
    if (!lesson) throw new AppError("LESSON_NOT_FOUND", 404, "Lesson not found");
    return lesson;
  }

  private async visibleQuestion(questionId: string): Promise<{ question: Question; lesson: LessonWithCourse }> {
    const question = await this.prisma.question.findUnique({ where: { id: questionId }, include: { lesson: { include: { course: true } } } });
    if (!question || question.hiddenAt) throw questionNotFound();
    return { question, lesson: question.lesson };
  }

  /** Anyone who may open the lesson may read its discussion: learners, authors, moderators and, for a free-preview lesson, any viewer. */
  private async readAccess(userId: string, lesson: LessonWithCourse): Promise<LearnAccess> {
    const access = await this.rules.learnAccess(userId, lesson.course, lesson);
    if (!access) throw denied(lesson.course);
    return access;
  }

  /** Posting needs an enrolment or authorship: preview viewers and moderators only read. */
  private async postAccess(userId: string, lesson: LessonWithCourse): Promise<LearnAccess> {
    const access = await this.readAccess(userId, lesson);
    if (access.via !== "ENROLLED" && access.via !== "AUTHOR") throw notAllowedToPost();
    return access;
  }

  private requireText(raw: string, max: number): string {
    const text = sanitizePlainText(raw, max);
    if (!text) throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { body: ["required"] } });
    return text;
  }

  private async authorsOf(userIds: string[]): Promise<Map<string, Author>> {
    const summaries = await this.profiles.summaries([...new Set(userIds)]);
    return new Map([...summaries].map(([id, s]) => [id, { handle: s.handle, displayName: s.displayName, avatarAssetId: s.avatarAssetId }]));
  }

  private questionView(q: Question, authors: Map<string, Author>, answerCount: number) {
    return { id: q.id, lessonId: q.lessonId, body: q.body, createdAt: q.createdAt.toISOString(), answerCount, author: authors.get(q.userId) ?? ANONYMOUS };
  }

  private answerView(a: Answer, authors: Map<string, Author>) {
    return { id: a.id, questionId: a.questionId, body: a.body, isInstructor: a.isInstructor, createdAt: a.createdAt.toISOString(), author: authors.get(a.userId) ?? ANONYMOUS };
  }
}
