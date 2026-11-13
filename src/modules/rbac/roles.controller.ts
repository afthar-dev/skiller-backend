import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { ApiResult } from "../../common/openapi/money";
import { ApiNoContent } from "../../common/openapi/responses";
import { RequireStepUp } from "../identity";
import { permissionRegistry } from "./permission.registry";
import { PrismaService } from "../../common/prisma/prisma.service";
import { RequirePermission } from "./require-permission.decorator";
import { MutationMeta, RolesService } from "./roles.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../../common/openapi/zod-schema";

const permissionKeys = z.array(z.string().min(1).max(100)).max(200);
const createSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "lower-case letters, digits and underscores, starting with a letter"),
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["PLATFORM", "ORG"]),
  permissionKeys,
});
const updateSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), permissionKeys: permissionKeys.optional() })
  .refine((v) => v.name !== undefined || v.permissionKeys !== undefined, "nothing to update");
const grantSchema = z.object({
  roleKey: z.string().min(1).max(100),
  orgId: z.string().min(1).max(200).optional(),
  expiresAt: z
    .string()
    .datetime()
    .transform((s) => new Date(s))
    .optional(),
});

const metaOf = (req: Request): MutationMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

@ApiTags("Admin")
@Controller("admin")
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("roles")
  @RequirePermission("rbac.view")
  @ApiOperation({ summary: "List roles with their permissions" })
  @ApiResult(200, "RoleList")
  async list() {
    return { items: await this.roles.list() };
  }

  @Get("permissions")
  @RequirePermission("rbac.view")
  @ApiOperation({ summary: "List permission keys (orphan = no longer declared in code)" })
  @ApiResult(200, "PermissionList")
  async permissions() {
    const rows = await this.prisma.permission.findMany({ orderBy: { key: "asc" }, select: { key: true, description: true, module: true } });
    const inCode = new Set(permissionRegistry.all().map((p) => p.key));
    return { items: rows.map((r) => ({ ...r, orphan: !inCode.has(r.key) })) };
  }

  @Post("roles")
  @RequirePermission("rbac.manage")
  @ApiOperation({ summary: "Create a custom role" })
  @ApiZodBody(createSchema)
  @ApiResult(201, "Role")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.roles.create(user.id, createSchema.parse(body), metaOf(req));
  }

  @Patch("roles/:id")
  @RequirePermission("rbac.manage")
  @ApiOperation({ summary: "Rename a role or replace its permissions" })
  @ApiZodBody(updateSchema)
  @ApiResult(200, "Role", "The role after the edit.")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.roles.update(user.id, id, updateSchema.parse(body), metaOf(req));
  }

  @Delete("roles/:id")
  @HttpCode(204)
  @RequirePermission("rbac.manage")
  @ApiOperation({ summary: "Delete a custom role" })
  @ApiNoContent("Deleted.")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    await this.roles.delete(user.id, id, metaOf(req));
  }

  @Post("users/:id/roles")
  @RequirePermission("role.grant")
  @RequireStepUp()
  @ApiOperation({ summary: "Grant a role to a user (step-up required)" })
  @ApiZodBody(grantSchema)
  @ApiResult(201, "UserRoleGrant")
  grant(@CurrentUser() user: AuthUser, @Param("id") userId: string, @Body() body: unknown, @Req() req: Request) {
    return this.roles.grant(user.id, { userId, ...grantSchema.parse(body) }, metaOf(req));
  }

  @Delete("users/:id/roles/:userRoleId")
  @HttpCode(204)
  @RequirePermission("role.grant")
  @RequireStepUp()
  @ApiOperation({ summary: "Revoke a role grant (step-up required)" })
  @ApiNoContent("Revoked.")
  async revoke(@CurrentUser() user: AuthUser, @Param("id") userId: string, @Param("userRoleId") userRoleId: string, @Req() req: Request) {
    if (!userRoleId) throw new AppError("NOT_FOUND", 404, "Role grant not found");
    await this.roles.revoke(user.id, userRoleId, { ...metaOf(req), userId });
  }
}
