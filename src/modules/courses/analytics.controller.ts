import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AnalyticsService } from "./analytics.service";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD (IST calendar day)");
const querySchema = z.object({ from: date.optional(), to: date.optional() }).strict();

@ApiTags("Course studio")
@Controller("studio/courses")
export class StudioAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // AuthenticatedOnly: who may read a course's analytics is decided by CoursePolicy (authors of the course only).
  @AuthenticatedOnly()
  @Get(":id/analytics")
  @ApiOperation({ summary: "Enrolments per IST day, revenue (seller share), completion rate and rating; per-lesson drop-off and watch time on standard/advanced plans" })
  @ApiQuery({ name: "from", required: false, description: "First IST day, YYYY-MM-DD (default: 29 days before `to`)" })
  @ApiQuery({ name: "to", required: false, description: "Last IST day, inclusive, YYYY-MM-DD (default: today). At most 366 days from `from`." })
  get(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    return this.analytics.forCourse(user, id, querySchema.parse({ from: query.from || undefined, to: query.to || undefined }));
  }
}
