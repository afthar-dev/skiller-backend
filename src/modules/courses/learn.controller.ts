import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { OptionalAuth, OptionalUser } from "../../common/auth/optional-auth.decorator";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { ApiJsonResponse } from "../../common/openapi/responses";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { learnCourseSchema, lessonContentSchema, progressResultSchema } from "./course-responses";
import { LearnService } from "./learn.service";
import { ProgressService } from "./progress.service";

/** Signed-out visitors read free-preview lessons; they are limited per address. Signed-in users are not limited here. */
export const ANON_LESSON_READS_PER_MINUTE = 60;

const heartbeatSchema = z.object({ positionSec: z.number().int().min(0).max(86_400) }).strict();

@ApiTags("Learning")
@Controller("learn")
export class LearnController {
  constructor(
    private readonly learn: LearnService,
    private readonly progress: ProgressService,
  ) {}

  @AuthenticatedOnly()
  @Get("courses/:slug")
  @ApiOperation({ summary: "The full curriculum of a course I may learn (enrolled, author), with my progress; 403 COURSE_NOT_ENROLLED otherwise" })
  @ApiJsonResponse(200, "Sections and lessons with the learner's progress.", learnCourseSchema)
  course(@CurrentUser() user: AuthUser, @Param("slug") slug: string) {
    return this.learn.course(user.id, slug);
  }

  @OptionalAuth()
  @RateLimit({ key: (req) => `learn:lesson:ip:${req.ip}`, limit: ANON_LESSON_READS_PER_MINUTE, windowSec: 60, anonymousOnly: true })
  @Get("lessons/:id")
  @ApiOperation({ summary: "A lesson's content: article text, the video asset id for playback, a 5-minute resource download. Free-preview lessons of a published course are open to anyone, signed in or not (signed out: 60 reads per minute per address; any other lesson needs a token and enrolment)" })
  @ApiJsonResponse(200, "The lesson's content; only the field of its type is filled.", lessonContentSchema)
  lesson(@OptionalUser() user: AuthUser | null, @Param("id") id: string) {
    return this.learn.lesson(user?.id ?? null, id);
  }

  @AuthenticatedOnly()
  @Put("lessons/:id/progress")
  @ApiOperation({ summary: "Video heartbeat: where the player is now. The server credits watch time (at most 2x real elapsed time), completes at 90% watched; one heartbeat per 5 s per lesson (429)" })
  @ApiJsonResponse(200, "Where the learner is now, the watch time credited and the course progress.", progressResultSchema)
  @ApiZodBody(heartbeatSchema)
  heartbeat(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.progress.heartbeat(user.id, id, heartbeatSchema.parse(body).positionSec);
  }

  @AuthenticatedOnly()
  @Post("lessons/:id/complete")
  @HttpCode(200)
  @ApiOperation({ summary: "Mark an article or resource lesson complete (videos complete by watching, quizzes by passing)" })
  @ApiJsonResponse(200, "The lesson's progress after completion.", progressResultSchema)
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.progress.complete(user.id, id);
  }
}
