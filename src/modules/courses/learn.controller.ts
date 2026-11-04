import { Controller, Get, Param } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { LearnService } from "./learn.service";

@ApiTags("Learning")
@Controller("learn")
export class LearnController {
  constructor(private readonly learn: LearnService) {}

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
}
