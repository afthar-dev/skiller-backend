import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { ApiJsonResponse, ApiNoContent } from "../../common/openapi/responses";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { publicCurriculumSchema, studioCurriculumSchema, studioLessonSchema, studioSectionSchema } from "./course-responses";
import { CurriculumService } from "./curriculum.service";
import { MAX_MARKDOWN_CHARS } from "./markdown";
import { singleLine } from "./text-schemas";

const sectionBody = z.object({ title: singleLine(1, 120) }).strict();

const uuid = z.string().uuid();
const lessonTitle = singleLine(1, 160);
const articleBody = z.string().max(MAX_MARKDOWN_CHARS);

const createLessonSchema = z
  .object({
    sectionId: uuid,
    title: lessonTitle,
    type: z.enum(["VIDEO", "ARTICLE", "QUIZ", "RESOURCE"]),
    isFreePreview: z.boolean().optional(),
    isRequired: z.boolean().optional(),
    videoAssetId: uuid.optional(),
    articleBody: articleBody.optional(),
    resourceAssetId: uuid.optional(),
  })
  .strict();

const updateLessonSchema = z
  .object({
    title: lessonTitle.optional(),
    isFreePreview: z.boolean().optional(),
    isRequired: z.boolean().optional(),
    videoAssetId: uuid.nullable().optional(),
    articleBody: articleBody.nullable().optional(),
    resourceAssetId: uuid.nullable().optional(),
  })
  .strict();

const orderSchema = z
  .object({
    expectedVersion: z.string().min(1).max(64),
    sections: z
      .array(z.object({ id: uuid, lessonIds: z.array(uuid).max(500) }).strict())
      .max(50),
  })
  .strict();

@ApiTags("Course studio")
@Controller("studio/courses/:id")
export class StudioCurriculumController {
  constructor(private readonly curriculum: CurriculumService) {}

  @AuthenticatedOnly()
  @Get("curriculum")
  @ApiOperation({ summary: "The full curriculum as the author sees it" })
  @ApiJsonResponse(200, "Sections with their lessons, in order.", studioCurriculumSchema)
  view(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.curriculum.authorView(user, id);
  }

  @AuthenticatedOnly()
  @Put("order")
  @ApiOperation({ summary: "Reorder the whole curriculum in one call: every section and lesson exactly once, positions become dense 0..n. Send the `version` the order was built from; a newer curriculum answers 409 ORDER_STALE" })
  @ApiJsonResponse(200, "The curriculum in its new order.", studioCurriculumSchema)
  @ApiZodBody(orderSchema)
  order(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.curriculum.reorder(user, id, orderSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Post("sections")
  @ApiOperation({ summary: "Add a section at the end" })
  @ApiJsonResponse(201, "The new, empty section.", studioSectionSchema)
  @ApiZodBody(sectionBody)
  createSection(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.curriculum.createSection(user, id, sectionBody.parse(body));
  }

  @AuthenticatedOnly()
  @Patch("sections/:sectionId")
  @ApiOperation({ summary: "Rename a section" })
  @ApiJsonResponse(200, "The section with its lessons.", studioSectionSchema)
  @ApiZodBody(sectionBody)
  updateSection(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("sectionId") sectionId: string, @Body() body: unknown) {
    return this.curriculum.updateSection(user, id, sectionId, sectionBody.parse(body));
  }

  @AuthenticatedOnly()
  @Delete("sections/:sectionId")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a section and its lessons" })
  @ApiNoContent("Deleted.")
  async deleteSection(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("sectionId") sectionId: string) {
    await this.curriculum.deleteSection(user, id, sectionId);
  }

  @AuthenticatedOnly()
  @Post("lessons")
  @ApiOperation({ summary: "Add a lesson at the end of a section; video / resource lessons attach the caller's READY media" })
  @ApiJsonResponse(201, "The new lesson.", studioLessonSchema)
  @ApiZodBody(createLessonSchema)
  createLesson(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.curriculum.createLesson(user, id, createLessonSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Patch("lessons/:lessonId")
  @ApiOperation({ summary: "Edit a lesson (title, flags, article text, attached media)" })
  @ApiJsonResponse(200, "The updated lesson.", studioLessonSchema)
  @ApiZodBody(updateLessonSchema)
  updateLesson(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("lessonId") lessonId: string, @Body() body: unknown) {
    return this.curriculum.updateLesson(user, id, lessonId, updateLessonSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Delete("lessons/:lessonId")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a lesson and release its media" })
  @ApiNoContent("Deleted.")
  async deleteLesson(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("lessonId") lessonId: string) {
    await this.curriculum.deleteLesson(user, id, lessonId);
  }
}

@ApiTags("Courses")
@Controller("courses")
export class PublicCurriculumController {
  constructor(private readonly curriculum: CurriculumService) {}

  @Public()
  @Get(":slug/curriculum")
  @ApiOperation({ summary: "Public curriculum of a published course: titles, durations, free-preview flags" })
  @ApiJsonResponse(200, "Sections and lessons with durations and totals.", publicCurriculumSchema)
  view(@Param("slug") slug: string) {
    return this.curriculum.publicView(slug);
  }
}
