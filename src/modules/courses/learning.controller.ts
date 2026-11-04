import { Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { EnrolmentsService } from "./enrolments.service";
import { SelfEnrolmentService } from "./self-enrolment.service";

@ApiTags("Courses")
@Controller()
export class LearningController {
  constructor(
    private readonly selfEnrolment: SelfEnrolmentService,
    private readonly enrolments: EnrolmentsService,
  ) {}

  @AuthenticatedOnly()
  @Post("courses/:slug/enrol")
  @ApiOperation({ summary: "Enrol without checkout: a free course, or any course of an organization you are a learner of (201 when new, 200 when already enrolled; 402 when the course has to be bought)" })
  async enrol(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Res({ passthrough: true }) res: Response) {
    const { enrolment, created } = await this.selfEnrolment.enrol(user.id, slug);
    res.status(created ? 201 : 200);
    return enrolment;
  }

  @AuthenticatedOnly()
  @Get("me/learning")
  @ApiOperation({ summary: "My courses with progress, most recently enrolled first" })
  @ApiPagination()
  learning(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.enrolments.learning(user.id, parsePage(query));
  }
}
