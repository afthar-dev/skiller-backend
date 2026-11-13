import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiResult, ApiPageResult } from "../../common/openapi/money";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import type { MutationMeta } from "../rbac";
import { AdminUsersService } from "./admin-users.service";
import { flagRulesSchema, FlagsService } from "./flags.service";
import { SETTING_KEYS } from "./settings.registry";
import { SettingsService } from "./settings.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiZodBody, ApiZodQuery, ApiPagination } from "../../common/openapi/zod-schema";

const metaOf = (req: Request): MutationMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

const searchSchema = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]).optional(),
  role: z.string().min(1).max(100).optional(),
});
const suspendSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const settingBody = z.object({ key: z.enum(SETTING_KEYS), value: z.unknown() }).strict();
const flagBody = z
  .object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "lower-case letters, digits and underscores, starting with a letter"), enabled: z.boolean(), rules: flagRulesSchema.nullable().optional() })
  .strict();

@ApiTags("Admin")
@Controller("admin")
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly settings: SettingsService,
    private readonly flags: FlagsService,
  ) {}

  @Get("users")
  @RequirePermission("user.view")
  @ApiOperation({ summary: "Search users" })
  @ApiZodQuery(searchSchema)
  @ApiPagination()
  @ApiPageResult("AdminUserRow")
  searchUsers(@Query() query: Record<string, unknown>) {
    return this.users.search(searchSchema.parse({ q: query.q || undefined, status: query.status || undefined, role: query.role || undefined }), parsePage(query));
  }

  @Get("users/:id")
  @RequirePermission("user.view")
  @ApiOperation({ summary: "User detail" })
  @ApiResult(200, "AdminUserDetail")
  user(@Param("id") id: string) {
    return this.users.detail(id);
  }

  @Post("users/:id/suspend")
  @HttpCode(200)
  @RequirePermission("user.suspend")
  @RequireStepUp()
  @ApiOperation({ summary: "Suspend a user (step-up required)" })
  @ApiZodBody(suspendSchema)
  @ApiResult(200, "UserStatusChange", "The user, suspended.")
  suspend(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.users.suspend(actor.id, id, suspendSchema.parse(body).reason, metaOf(req));
  }

  @Post("users/:id/unsuspend")
  @HttpCode(200)
  @RequirePermission("user.suspend")
  @RequireStepUp()
  @ApiOperation({ summary: "Lift a suspension (step-up required)" })
  @ApiResult(200, "UserStatusChange", "The user, active again.")
  unsuspend(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.users.unsuspend(actor.id, id, metaOf(req));
  }

  @Post("users/:id/revoke-sessions")
  @HttpCode(200)
  @RequirePermission("user.revoke_sessions")
  @ApiOperation({ summary: "Revoke all of a user's sessions" })
  @ApiResult(200, "SessionsRevoked")
  revokeSessions(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.users.revokeSessions(actor.id, id, metaOf(req));
  }

  @Get("settings")
  @RequirePermission("settings.manage")
  @ApiOperation({ summary: "List platform settings" })
  @ApiResult(200, "SettingList")
  listSettings() {
    return this.settings.list();
  }

  @Put("settings")
  @RequirePermission("settings.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Set a platform setting (step-up required)" })
  @ApiZodBody(settingBody)
  @ApiResult(200, "SettingSaved")
  putSetting(@CurrentUser() actor: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { key, value } = settingBody.parse(body);
    return this.settings.set(actor.id, key, value, metaOf(req));
  }

  @Get("flags")
  @RequirePermission("flags.manage")
  @ApiOperation({ summary: "List feature flags" })
  @ApiResult(200, "FeatureFlagList")
  listFlags() {
    return this.flags.list();
  }

  @Put("flags")
  @RequirePermission("flags.manage")
  @ApiOperation({ summary: "Create or update a feature flag" })
  @ApiZodBody(flagBody)
  @ApiResult(200, "FeatureFlag")
  putFlag(@CurrentUser() actor: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { key, enabled, rules } = flagBody.parse(body);
    return this.flags.set(actor.id, key, { enabled, rules }, metaOf(req));
  }
}
