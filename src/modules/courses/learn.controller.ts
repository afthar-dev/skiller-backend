import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { LearnService } from "./learn.service";
import { ProgressService } from "./progress.service";

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
  course(@CurrentUser() user: AuthUser, @Param("slug") slug: string) {
    return this.learn.course(user.id, slug);
  }

  @AuthenticatedOnly()
  @Get("lessons/:id")
  @ApiOperation({ summary: "A lesson's content: article text, the video asset id for playback, a 5-minute resource download. Free-preview lessons are open to anyone" })
  lesson(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.learn.lesson(user.id, id);
  }

  @AuthenticatedOnly()
  @Put("lessons/:id/progress")
  @ApiOperation({ summary: "Video heartbeat: where the player is now. The server credits watch time (at most 2x real elapsed time), completes at 90% watched; one heartbeat per 5 s per lesson (429)" })
  @ApiZodBody(heartbeatSchema)
  heartbeat(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.progress.heartbeat(user.id, id, heartbeatSchema.parse(body).positionSec);
  }

  @AuthenticatedOnly()
  @Post("lessons/:id/complete")
  @HttpCode(200)
  @ApiOperation({ summary: "Mark an article or resource lesson complete (videos complete by watching, quizzes by passing)" })
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.progress.complete(user.id, id);
  }
}
