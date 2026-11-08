import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiJsonResponse } from "../../common/openapi/responses";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { answerPageSchema, answerViewSchema, questionPageSchema, questionViewSchema } from "./course-responses";
import { ANSWER_BODY_MAX, QUESTION_BODY_MAX, QaService } from "./qa.service";

const questionSchema = z.object({ body: z.string().max(QUESTION_BODY_MAX) }).strict();
const answerSchema = z.object({ body: z.string().max(ANSWER_BODY_MAX) }).strict();

@ApiTags("Learning")
@Controller("learn")
export class QaController {
  constructor(private readonly qa: QaService) {}

  @AuthenticatedOnly()
  @Get("lessons/:id/questions")
  @ApiOperation({ summary: "Questions about a lesson, newest first. Open to whoever may open the lesson (a free-preview lesson's discussion is readable by anyone signed in)" })
  @ApiPagination()
  @ApiJsonResponse(200, "A page of questions; nextCursor is null on the last page.", questionPageSchema)
  questions(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    return this.qa.questions(user.id, id, parsePage(query));
  }

  @AuthenticatedOnly()
  @Post("lessons/:id/questions")
  @ApiOperation({ summary: "Ask a question about a lesson (enrolled learners and authors; plain text up to 2000 characters; 20 per hour)" })
  @ApiJsonResponse(201, "The new question.", questionViewSchema)
  @ApiZodBody(questionSchema)
  ask(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.qa.ask(user.id, id, questionSchema.parse(body).body);
  }

  @AuthenticatedOnly()
  @Get("questions/:id/answers")
  @ApiOperation({ summary: "Answers to a question, newest first" })
  @ApiPagination()
  @ApiJsonResponse(200, "A page of answers; nextCursor is null on the last page.", answerPageSchema)
  answers(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    return this.qa.answers(user.id, id, parsePage(query));
  }

  @AuthenticatedOnly()
  @Post("questions/:id/answers")
  @ApiOperation({ summary: "Answer a question (enrolled learners and authors; an author's answer is marked isInstructor; plain text up to 5000 characters; 60 per hour)" })
  @ApiJsonResponse(201, "The new answer.", answerViewSchema)
  @ApiZodBody(answerSchema)
  answer(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.qa.answer(user.id, id, answerSchema.parse(body).body);
  }
}
