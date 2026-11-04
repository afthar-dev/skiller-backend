import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { RequirePermission } from "../rbac";
import { CategoriesService, type CategoryMeta } from "./categories.service";

const name = z.string().trim().min(2).max(60);
const createSchema = z.object({ name, position: z.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() }).strict();
const updateSchema = z.object({ name: name.optional(), position: z.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() }).strict();

const metaOf = (user: AuthUser, req: Request): CategoryMeta => ({ actorId: user.id, ip: req.ip, requestId: (req as Request & { id?: string }).id });

@ApiTags("Courses")
@Controller("categories")
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Active course categories" })
  list() {
    return this.categories.listActive();
  }
}

@ApiTags("Course admin")
@Controller("admin/course-categories")
export class AdminCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermission("course.categories.manage")
  @ApiOperation({ summary: "All course categories, including inactive ones" })
  list() {
    return this.categories.listAll();
  }

  @Post()
  @RequirePermission("course.categories.manage")
  @ApiOperation({ summary: "Create a category" })
  @ApiZodBody(createSchema)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.categories.create(createSchema.parse(body), metaOf(user, req));
  }

  @Patch(":id")
  @RequirePermission("course.categories.manage")
  @ApiOperation({ summary: "Rename, reorder, activate or deactivate a category" })
  @ApiZodBody(updateSchema)
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.categories.update(id, updateSchema.parse(body), metaOf(user, req));
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("course.categories.manage")
  @ApiOperation({ summary: "Delete a category no course uses" })
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    await this.categories.remove(id, metaOf(user, req));
  }
}
