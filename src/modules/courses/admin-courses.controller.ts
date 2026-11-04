import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RequirePermission } from "../rbac";
import type { ActionMeta } from "./course-state";
import { ModerationService } from "./moderation.service";

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

const metaOf = (user: AuthUser, req: Request): ActionMeta => ({ actorId: user.id, ip: req.ip, requestId: (req as Request & { id?: string }).id });

@ApiTags("Course admin")
@Controller("admin/courses")
export class AdminCoursesController {
  constructor(private readonly moderation: ModerationService) {}

  @Get("review-queue")
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Courses waiting for a moderation decision, longest waiting first" })
  @ApiPagination()
  queue(@Query() query: Record<string, unknown>) {
    return this.moderation.queue(parsePage(query));
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Publish a course in review (the plan limit is checked again)" })
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.moderation.approve(id, metaOf(user, req));
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Send a course in review back to draft with a reason" })
  @ApiZodBody(reasonSchema)
  reject(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.reject(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post(":id/flag")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Hide a published course from the catalog (enrolled learners keep access)" })
  @ApiZodBody(reasonSchema)
  flag(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.flag(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post(":id/unflag")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Put a flagged course back on the catalog" })
  @ApiZodBody(reasonSchema)
  unflag(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.unflag(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }
}
