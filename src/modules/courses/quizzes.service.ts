import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, type Quiz, type QuizQuestion } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { lockCourseForEdit } from "./course-lock";
import { CoursePolicy } from "./course.policy";
import { toStoredQuestion, type StoredOption } from "./quiz-scoring";

export const MAX_QUIZ_QUESTIONS = 100;

export interface QuizInput {
  passPct: number;
  questions: Array<{
    id?: string;
    prompt: string;
    kind: "SINGLE" | "MULTIPLE";
    options: Array<{ id?: string; text: string; isCorrect: boolean }>;
  }>;
}

export interface StudioQuizView {
  id: string;
  lessonId: string;
  passPct: number;
  questions: Array<{ id: string; prompt: string; kind: "SINGLE" | "MULTIPLE"; position: number; options: Array<{ id: string; text: string; isCorrect: boolean }> }>;
}

const lessonNotFound = () => new AppError("LESSON_NOT_FOUND", 404, "Lesson not found");
const invalid = (message: string, details: Record<string, unknown> = {}) => new AppError("QUIZ_INVALID", 422, message, details);

const toView = (lessonId: string, quiz: Quiz, questions: QuizQuestion[]): StudioQuizView => ({
  id: quiz.id,
  lessonId,
  passPct: quiz.passPct,
  questions: questions
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((row) => {
      const q = toStoredQuestion(row);
      return { id: q.id, prompt: row.prompt, kind: q.kind, position: row.position, options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: q.correct.includes(o.id) })) };
    }),
});

/**
 * Studio side of quizzes: one quiz per QUIZ lesson, written as a whole. Question and option ids that the client sends back are kept
 * (so attempts and learner screens keep pointing at the same things); anything new gets a fresh id; questions left out are removed.
 * Every write takes the course edit lock, so a course in review cannot change under a moderator.
 */
@Injectable()
export class QuizzesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CoursePolicy,
  ) {}

  async get(user: { id: string }, courseId: string, lessonId: string): Promise<StudioQuizView> {
    await this.policy.loadForRead(user, courseId);
    const lesson = await this.quizLesson(this.prisma, courseId, lessonId);
    const quiz = lesson.quizId ? await this.prisma.quiz.findUnique({ where: { id: lesson.quizId }, include: { questions: true } }) : null;
    if (!quiz) throw new AppError("QUIZ_NOT_FOUND", 404, "This lesson has no quiz yet");
    return toView(lessonId, quiz, quiz.questions);
  }

  async put(user: { id: string }, courseId: string, lessonId: string, input: QuizInput): Promise<StudioQuizView> {
    await this.policy.loadForAuthor(user, courseId);
    assertSemantics(input);
    return this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const lesson = await this.quizLesson(tx, courseId, lessonId);
      let quiz = lesson.quizId ? await tx.quiz.findUnique({ where: { id: lesson.quizId } }) : null;
      if (quiz) quiz = await tx.quiz.update({ where: { id: quiz.id }, data: { passPct: input.passPct } });
      else {
        quiz = await tx.quiz.create({ data: { courseId, passPct: input.passPct } });
        await tx.lesson.update({ where: { id: lessonId }, data: { quizId: quiz.id } });
      }

      const existing = new Set((await tx.quizQuestion.findMany({ where: { quizId: quiz.id }, select: { id: true } })).map((q) => q.id));
      const sentIds = input.questions.flatMap((q) => (q.id ? [q.id] : []));
      if (new Set(sentIds).size !== sentIds.length) throw invalid("A question id appears twice");
      const unknown = sentIds.filter((id) => !existing.has(id));
      if (unknown.length > 0) throw invalid("A question id does not belong to this quiz", { unknown });

      await tx.quizQuestion.deleteMany({ where: { quizId: quiz.id, id: { notIn: sentIds } } });
      for (const [position, q] of input.questions.entries()) {
        const options: StoredOption[] = q.options.map((o) => ({ id: o.id ?? randomUUID(), text: o.text }));
        const correct = q.options.flatMap((o, i) => (o.isCorrect ? [options[i].id] : []));
        const data = { prompt: q.prompt, kind: q.kind, options: options as unknown as Prisma.InputJsonValue, correct: correct as unknown as Prisma.InputJsonValue, position };
        if (q.id) await tx.quizQuestion.update({ where: { id: q.id }, data });
        else await tx.quizQuestion.create({ data: { ...data, quizId: quiz.id } });
      }
      return toView(lessonId, quiz, await tx.quizQuestion.findMany({ where: { quizId: quiz.id } }));
    });
  }

  async remove(user: { id: string }, courseId: string, lessonId: string): Promise<void> {
    await this.policy.loadForAuthor(user, courseId);
    await this.prisma.$transaction(async (tx) => {
      await lockCourseForEdit(tx, courseId);
      const lesson = await this.quizLesson(tx, courseId, lessonId);
      await assertQuizMayGo(tx, courseId);
      if (!lesson.quizId) throw new AppError("QUIZ_NOT_FOUND", 404, "This lesson has no quiz yet");
      await tx.lesson.update({ where: { id: lessonId }, data: { quizId: null } });
      await tx.quiz.deleteMany({ where: { id: lesson.quizId } });
    });
  }

  private async quizLesson(db: Prisma.TransactionClient | PrismaService, courseId: string, lessonId: string) {
    const lesson = await db.lesson.findFirst({ where: { id: lessonId, courseId }, select: { id: true, type: true, quizId: true } });
    if (!lesson) throw lessonNotFound();
    if (lesson.type !== "QUIZ") throw new AppError("LESSON_NOT_QUIZ", 422, "Only a QUIZ lesson holds a quiz");
    return lesson;
  }
}

/**
 * A live course (published, flagged or archived) keeps every quiz it has: learners who have not passed yet could never finish a course whose
 * quiz lesson has nothing to attempt. Quizzes can be edited there, not removed.
 */
async function assertQuizMayGo(tx: Prisma.TransactionClient, courseId: string): Promise<void> {
  if (await courseIsLive(tx, courseId)) throw quizRequired();
}

/** The course is out of draft: learners may be part-way through it. */
export async function courseIsLive(tx: Prisma.TransactionClient, courseId: string): Promise<boolean> {
  const course = await tx.course.findUnique({ where: { id: courseId }, select: { status: true, flaggedAt: true } });
  return course !== null && (course.status === "PUBLISHED" || course.status === "ARCHIVED" || course.flaggedAt !== null);
}

export const quizRequired = () => new AppError("COURSE_QUIZ_REQUIRED", 409, "A live course keeps its quizzes: edit the questions instead of removing the quiz, and add new quiz lessons while the course is a draft");

/** What the shape check cannot see: the right answers must fit the question kind, and option ids must be unique within a question. */
function assertSemantics(input: QuizInput): void {
  for (const [i, q] of input.questions.entries()) {
    const right = q.options.filter((o) => o.isCorrect).length;
    if (q.kind === "SINGLE" && right !== 1) throw invalid("A single-choice question needs exactly one correct option", { question: i });
    if (q.kind === "MULTIPLE" && right < 1) throw invalid("A multiple-choice question needs at least one correct option", { question: i });
    const ids = q.options.flatMap((o) => (o.id ? [o.id] : []));
    if (new Set(ids).size !== ids.length) throw invalid("An option id appears twice in one question", { question: i });
  }
}
