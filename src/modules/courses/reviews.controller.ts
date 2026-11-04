import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RequirePermission } from "../rbac";
import { ContentModerationService } from "./content-moderation.service";
import type { ActionMeta } from "./course-state";
import { REVIEW_BODY_MAX, ReviewsService } from "./reviews.service";

const reviewSchema = z.object({ rating: z.number().int().min(1).max(5), body: z.string().max(REVIEW_BODY_MAX).nullable().optional() }).strict();
const replySchema = z.object({ body: z.string().max(REVIEW_BODY_MAX) }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

const metaOf = (user: AuthUser, req: Request): ActionMeta => ({ actorId: user.id, ip: req.ip, requestId: (req as Request & { id?: string }).id });

@ApiTags("Course reviews")
@Controller("courses/:slug/reviews")
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Reviews of a published course, newest first, with the rating summary (the average is null until 3 learners rated)" })
  @ApiPagination()
  list(@Param("slug") slug: string, @Query() query: Record<string, unknown>) {
    return this.reviews.list(slug, parsePage(query));
  }

  @AuthenticatedOnly()
  @Get("mine")
  @ApiOperation({ summary: "My review of this course (404 when I have none)" })
  mine(@CurrentUser() user: AuthUser, @Param("slug") slug: string) {
    return this.reviews.mine(user.id, slug);
  }

  @AuthenticatedOnly()
  @Put("mine")
  @ApiOperation({ summary: "Write or change my review: 1-5 stars and optional plain text (2000 characters). Enrolled learners only, not authors; 10 writes per hour" })
  @ApiZodBody(reviewSchema)
  put(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Body() body: unknown) {
    const input = reviewSchema.parse(body);
    return this.reviews.upsert(user.id, slug, { rating: input.rating, body: input.body ?? null });
  }
}

@ApiTags("Course studio")
@Controller("studio/reviews")
export class StudioReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  // AuthenticatedOnly: who may answer a review is decided per course by CoursePolicy (its authors).
  @AuthenticatedOnly()
  @Put(":id/reply")
  @ApiOperation({ summary: "Reply to a review of a course I author; one reply per review, editable" })
  @ApiZodBody(replySchema)
  reply(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.reviews.reply(user, id, replySchema.parse(body).body);
  }
}

@ApiTags("Course admin")
@Controller("admin")
export class AdminContentController {
  constructor(private readonly moderation: ContentModerationService) {}

  @Post("reviews/:id/hide")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Hide a review (out of the list and the course rating), with a reason" })
  @ApiZodBody(reasonSchema)
  hideReview(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.hideReview(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post("reviews/:id/unhide")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Show a hidden review again" })
  @ApiZodBody(reasonSchema)
  unhideReview(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.unhideReview(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post("questions/:id/hide")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Hide a lesson question, with a reason" })
  @ApiZodBody(reasonSchema)
  hideQuestion(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.hideQuestion(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post("questions/:id/unhide")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Show a hidden question again" })
  @ApiZodBody(reasonSchema)
  unhideQuestion(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.unhideQuestion(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post("answers/:id/hide")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Hide an answer, with a reason" })
  @ApiZodBody(reasonSchema)
  hideAnswer(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.hideAnswer(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }

  @Post("answers/:id/unhide")
  @HttpCode(200)
  @RequirePermission("course.review")
  @ApiOperation({ summary: "Show a hidden answer again" })
  @ApiZodBody(reasonSchema)
  unhideAnswer(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.unhideAnswer(id, reasonSchema.parse(body).reason, metaOf(user, req));
  }
}
