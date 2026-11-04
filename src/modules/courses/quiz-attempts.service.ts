import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CourseAccessRules } from "./course-access-rules";
import { denied, notEnrolled } from "./learn-errors";
import { ProgressService } from "./progress.service";
import { scoreAttempt, toStoredQuestion, type GivenAnswer } from "./quiz-scoring";

/** At least this long between two attempts of one learner at one quiz. */
export const QUIZ_COOLDOWN_MS = 60_000;

const quizNotFound = () => new AppError("QUIZ_NOT_FOUND", 404, "Quiz not found");

/**
 * The learner's side of quizzes. Every call goes through the course access rules; attempts additionally need an active enrolment
 * (authors and moderators may look, not play). The right answers leave the server only once the learner holds a passing attempt.
 */
@Injectable()
export class QuizAttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: CourseAccessRules,
    private readonly progress: ProgressService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async view(userId: string, quizId: string) {
    const { quiz, lesson } = await this.open(userId, quizId);
    const [passed, last] = await Promise.all([
      this.prisma.quizAttempt.findFirst({ where: { quizId, userId, passed: true }, select: { id: true } }),
      this.prisma.quizAttempt.findFirst({ where: { quizId, userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);
    const reveal = passed !== null;
    const next = last ? new Date(last.createdAt.getTime() + QUIZ_COOLDOWN_MS) : null;
    return {
      id: quiz.id,
      lessonId: lesson.id,
      courseSlug: lesson.course.slug,
      passPct: quiz.passPct,
      passed: reveal,
      nextAttemptAt: next && next > this.clock.now() ? next.toISOString() : null,
      questions: quiz.questions.map((row) => {
        const q = toStoredQuestion(row);
        return {
          id: q.id,
          prompt: row.prompt,
          kind: q.kind,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
          ...(reveal ? { correct: q.correct } : {}),
        };
      }),
    };
  }

  async attempt(userId: string, quizId: string, answers: GivenAnswer[]) {
    const { lesson, access } = await this.open(userId, quizId);
    if (!access.progress) throw notEnrolled();
    return this.prisma.$transaction(async (tx) => {
      // The learner's enrolment row is the lock: two submissions of one learner run one after the other, so the second sees the first's attempt.
      if (!(await this.progress.lockLearner(tx, lesson.courseId, userId))) throw notEnrolled();
      const now = this.clock.now();
      const last = await tx.quizAttempt.findFirst({ where: { quizId, userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (last) {
        const waitMs = last.createdAt.getTime() + QUIZ_COOLDOWN_MS - now.getTime();
        if (waitMs > 0) throw new AppError("QUIZ_COOLDOWN", 429, "Wait a minute between attempts", { retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) });
      }

      const quiz = await tx.quiz.findUnique({ where: { id: quizId }, include: { questions: { orderBy: { position: "asc" } } } });
      if (!quiz) throw quizNotFound();
      if (quiz.questions.length === 0) throw new AppError("QUIZ_EMPTY", 422, "This quiz has no questions yet");
      const stored = quiz.questions.map(toStoredQuestion);
      const { scorePct } = scoreAttempt(stored, answers);
      const passed = scorePct >= quiz.passPct;

      const row = await tx.quizAttempt.create({ data: { quizId, userId, answers: answers as unknown as Prisma.InputJsonValue, scorePct, passed, createdAt: now } });
      if (passed) await this.progress.markLessonCompleted(tx, userId, lesson.id, "QUIZ");
      return {
        attemptId: row.id,
        scorePct,
        passed,
        passPct: quiz.passPct,
        nextAttemptAt: new Date(now.getTime() + QUIZ_COOLDOWN_MS).toISOString(),
        ...(passed ? { correct: Object.fromEntries(stored.map((q) => [q.id, q.correct])) } : {}),
      };
    });
  }

  /**
   * The quiz and its lesson, if the user may open it. A quiz lesson is never a free preview, whatever the lesson row says: previews
   * must not see questions, so the preview rule is switched off here.
   */
  private async open(userId: string, quizId: string) {
    const [quiz, lesson] = await Promise.all([
      this.prisma.quiz.findUnique({ where: { id: quizId }, include: { questions: { orderBy: { position: "asc" } } } }),
      this.prisma.lesson.findFirst({ where: { quizId }, include: { course: true } }),
    ]);
    if (!quiz || !lesson) throw quizNotFound();
    const access = await this.rules.learnAccess(userId, lesson.course, { isFreePreview: false });
    if (!access) throw denied(lesson.course);
    return { quiz, lesson, access };
  }
}
