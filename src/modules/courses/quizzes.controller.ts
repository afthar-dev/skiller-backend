import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { ApiJsonResponse, ApiNoContent } from "../../common/openapi/responses";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { quizAttemptSchema, quizViewSchema, studioQuizSchema } from "./course-responses";
import { QuizAttemptsService } from "./quiz-attempts.service";
import { MAX_QUIZ_QUESTIONS, QuizzesService } from "./quizzes.service";

const stableId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const quizSchema = z
  .object({
    passPct: z.number().int().min(1).max(100).default(70),
    questions: z
      .array(
        z
          .object({
            id: stableId.optional(),
            prompt: z.string().trim().min(1).max(1000),
            kind: z.enum(["SINGLE", "MULTIPLE"]),
            options: z.array(z.object({ id: stableId.optional(), text: z.string().trim().min(1).max(500), isCorrect: z.boolean() }).strict()).min(2).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_QUIZ_QUESTIONS),
  })
  .strict();

const attemptSchema = z
  .object({
    answers: z
      .array(z.object({ questionId: z.string().min(1).max(64), optionIds: z.array(z.string().min(1).max(64)).max(10) }).strict())
      .max(MAX_QUIZ_QUESTIONS),
  })
  .strict();

@ApiTags("Course studio")
@Controller("studio/courses/:id/lessons/:lessonId/quiz")
export class StudioQuizzesController {
  constructor(private readonly quizzes: QuizzesService) {}

  @AuthenticatedOnly()
  @Get()
  @ApiOperation({ summary: "The quiz of a QUIZ lesson as the author sees it, correct options marked" })
  @ApiJsonResponse(200, "The quiz with its correct options marked.", studioQuizSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("lessonId") lessonId: string) {
    return this.quizzes.get(user, id, lessonId);
  }

  @AuthenticatedOnly()
  @Put()
  @ApiOperation({ summary: "Create or replace the quiz of a QUIZ lesson. Ids sent back are kept; questions left out are removed. Blocked while the course is in review" })
  @ApiJsonResponse(200, "The saved quiz.", studioQuizSchema)
  @ApiZodBody(quizSchema)
  put(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("lessonId") lessonId: string, @Body() body: unknown) {
    return this.quizzes.put(user, id, lessonId, quizSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: "Remove the quiz from its lesson (learners who passed keep their completion)" })
  @ApiNoContent("Removed.")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("lessonId") lessonId: string) {
    await this.quizzes.remove(user, id, lessonId);
  }
}

@ApiTags("Learning")
@Controller("learn/quizzes")
export class LearnQuizzesController {
  constructor(private readonly attempts: QuizAttemptsService) {}

  @AuthenticatedOnly()
  @Get(":id")
  @ApiOperation({ summary: "A quiz's questions for a learner. The right answers are included only once the learner has a passing attempt" })
  @ApiJsonResponse(200, "The quiz as the learner sees it.", quizViewSchema)
  view(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.attempts.view(user.id, id);
  }

  @AuthenticatedOnly()
  @Post(":id/attempts")
  @ApiOperation({ summary: "Submit answers (option ids per question). Score = floor(100 x right questions / total); one attempt per minute (429 QUIZ_COOLDOWN). Passing completes the lesson and reveals the answers" })
  @ApiJsonResponse(201, "The score, whether it passed and when the next attempt is allowed.", quizAttemptSchema)
  @ApiZodBody(attemptSchema)
  attempt(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.attempts.attempt(user.id, id, attemptSchema.parse(body).answers);
  }
}
