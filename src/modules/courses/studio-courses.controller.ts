import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { COURSE_LANGUAGES, COURSE_LEVELS, SLUG_PATTERN } from "./course-rules";
import { CoursesService } from "./courses.service";
import { PublishingService } from "./publishing.service";

const title = z.string().trim().min(3).max(120);
const subtitle = z.string().trim().min(1).max(200).nullable();
const description = z.string().trim().max(10_000);
const tags = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .max(10)
  .transform((list) => [...new Set(list)]);
const price = z.string().regex(/^\d{1,12}$/, "integer paise as a decimal string, e.g. \"49900\"").transform((v) => BigInt(v));
const language = z.enum(COURSE_LANGUAGES);
const level = z.enum(COURSE_LEVELS);
const assetId = z.string().uuid().nullable();

const createSchema = z
  .object({
    ownerType: z.enum(["USER", "ORG"]).default("USER"),
    orgId: z.string().uuid().optional(),
    title,
    subtitle: subtitle.optional(),
    description: description.default(""),
    categoryId: z.string().uuid(),
    level: level.default("ALL"),
    language,
    tags: tags.default([]),
    pricePaise: price.default("0"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.ownerType === "ORG" && !v.orgId) ctx.addIssue({ code: "custom", path: ["orgId"], message: "required for an organization course" });
    if (v.ownerType === "USER" && v.orgId) ctx.addIssue({ code: "custom", path: ["orgId"], message: "only for an organization course" });
  });

const updateSchema = z
  .object({
    title: title.optional(),
    subtitle: subtitle.optional(),
    description: description.optional(),
    categoryId: z.string().uuid().optional(),
    level: level.optional(),
    language: language.optional(),
    tags: tags.optional(),
    pricePaise: price.optional(),
    slug: z.string().min(3).max(80).regex(SLUG_PATTERN, "lower-case letters, digits and single hyphens").optional(),
    thumbnailAssetId: assetId.optional(),
    promoVideoAssetId: assetId.optional(),
  })
  .strict();

const listQuery = z.object({ status: z.enum(["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"]).optional() });

@ApiTags("Course studio")
@Controller("studio/courses")
export class StudioCoursesController {
  constructor(
    private readonly courses: CoursesService,
    private readonly publishing: PublishingService,
  ) {}

  // AuthenticatedOnly, not course.create: who may create is decided per owner by CoursePolicy (creator for yourself, org author for an org).
  @AuthenticatedOnly()
  @Post()
  @ApiOperation({ summary: "Create a draft course for yourself or for an organization you author for" })
  @ApiZodBody(createSchema)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.courses.create(user, createSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Get()
  @ApiOperation({ summary: "Your courses and those of the organizations you author for" })
  @ApiPagination()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    const { status } = listQuery.parse({ status: query.status || undefined });
    return this.courses.list(user, parsePage(query), status);
  }

  @AuthenticatedOnly()
  @Get(":id")
  @ApiOperation({ summary: "One of your courses" })
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.courses.get(user, id);
  }

  @AuthenticatedOnly()
  @Patch(":id")
  @ApiOperation({ summary: "Edit a course (including its thumbnail and promo video)" })
  @ApiZodBody(updateSchema)
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.courses.update(user, id, updateSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({ summary: "Submit a complete draft for moderator review (COURSE_NOT_PUBLISHABLE lists what is missing)" })
  submit(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.publishing.submit(user, id, { ip: req.ip, requestId: (req as Request & { id?: string }).id });
  }

  @AuthenticatedOnly()
  @Post(":id/withdraw")
  @HttpCode(200)
  @ApiOperation({ summary: "Take a course back from review to draft (content is locked while it is in review)" })
  withdraw(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.publishing.withdraw(user, id, { ip: req.ip, requestId: (req as Request & { id?: string }).id });
  }

  @AuthenticatedOnly()
  @Post(":id/archive")
  @HttpCode(200)
  @ApiOperation({ summary: "Archive a published course: off the catalog and not for sale; enrolled learners keep access" })
  archive(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.publishing.archive(user, id, { ip: req.ip, requestId: (req as Request & { id?: string }).id });
  }

  @AuthenticatedOnly()
  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a draft that was never published" })
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.courses.remove(user, id);
  }
}
