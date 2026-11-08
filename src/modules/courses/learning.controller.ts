import { Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiJsonResponse } from "../../common/openapi/responses";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { enrolmentSchema, learningPageSchema, publicCourseSchema } from "./course-responses";
import { CoursesService } from "./courses.service";
import { EnrolmentsService } from "./enrolments.service";
import { SelfEnrolmentService } from "./self-enrolment.service";

@ApiTags("Courses")
@Controller()
export class LearningController {
  constructor(
    private readonly selfEnrolment: SelfEnrolmentService,
    private readonly enrolments: EnrolmentsService,
    private readonly courses: CoursesService,
  ) {}

  @Public()
  @Get("courses/:slug")
  @ApiOperation({ summary: "Public page of a published course (hidden when flagged, unpublished or archived)" })
  @ApiJsonResponse(200, "The public page of the course.", publicCourseSchema)
  page(@Param("slug") slug: string) {
    return this.courses.publicPage(slug);
  }

  @AuthenticatedOnly()
  @Post("courses/:slug/enrol")
  @ApiOperation({ summary: "Enrol without checkout: a free course, or any course of an organization you are a learner of (201 when new, 200 when already enrolled; 402 when the course has to be bought)" })
  @ApiJsonResponse(201, "Newly enrolled.", enrolmentSchema)
  @ApiJsonResponse(200, "Already enrolled.", enrolmentSchema)
  async enrol(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Res({ passthrough: true }) res: Response) {
    const { enrolment, created } = await this.selfEnrolment.enrol(user.id, slug);
    res.status(created ? 201 : 200);
    return enrolment;
  }

  @AuthenticatedOnly()
  @Get("me/learning")
  @ApiOperation({ summary: "My courses with progress, most recently enrolled first" })
  @ApiPagination()
  @ApiJsonResponse(200, "A page of enrolments; nextCursor is null on the last page.", learningPageSchema)
  learning(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.enrolments.learning(user.id, parsePage(query));
  }
}
