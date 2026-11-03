import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { RequireStepUp } from "../identity/require-step-up.decorator";
import { RequirePermission } from "../rbac/require-permission.decorator";
import type { MutationMeta } from "../rbac/roles.service";
import { AdminUsersService } from "./admin-users.service";
import { flagRulesSchema, FlagsService } from "./flags.service";
import { SETTING_KEYS } from "./settings.registry";
import { SettingsService } from "./settings.service";

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

@Controller("admin")
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly settings: SettingsService,
    private readonly flags: FlagsService,
  ) {}

  @Get("users")
  @RequirePermission("user.view")
  searchUsers(@Query() query: Record<string, unknown>) {
    return this.users.search(searchSchema.parse({ q: query.q || undefined, status: query.status || undefined, role: query.role || undefined }), parsePage(query));
  }

  @Get("users/:id")
  @RequirePermission("user.view")
  user(@Param("id") id: string) {
    return this.users.detail(id);
  }

  @Post("users/:id/suspend")
  @HttpCode(200)
  @RequirePermission("user.suspend")
  @RequireStepUp()
  suspend(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.users.suspend(actor.id, id, suspendSchema.parse(body).reason, metaOf(req));
  }

  @Post("users/:id/unsuspend")
  @HttpCode(200)
  @RequirePermission("user.suspend")
  @RequireStepUp()
  unsuspend(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.users.unsuspend(actor.id, id, metaOf(req));
  }

  @Post("users/:id/revoke-sessions")
  @HttpCode(200)
  @RequirePermission("user.revoke_sessions")
  revokeSessions(@CurrentUser() actor: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.users.revokeSessions(actor.id, id, metaOf(req));
  }

  @Get("settings")
  @RequirePermission("settings.manage")
  listSettings() {
    return this.settings.list();
  }

  @Put("settings")
  @RequirePermission("settings.manage")
  @RequireStepUp()
  putSetting(@CurrentUser() actor: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { key, value } = settingBody.parse(body);
    return this.settings.set(actor.id, key, value, metaOf(req));
  }

  @Get("flags")
  @RequirePermission("flags.manage")
  listFlags() {
    return this.flags.list();
  }

  @Put("flags")
  @RequirePermission("flags.manage")
  putFlag(@CurrentUser() actor: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { key, enabled, rules } = flagBody.parse(body);
    return this.flags.set(actor.id, key, { enabled, rules }, metaOf(req));
  }
}
