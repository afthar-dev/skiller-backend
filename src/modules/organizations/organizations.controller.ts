import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { RequirePermission } from "../rbac/require-permission.decorator";
import type { MutationMeta } from "../rbac/roles.service";
import { INVITABLE_ROLE_KEYS, OrganizationsService } from "./organizations.service";

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3-40 characters: lower-case letters, digits and hyphens, not starting or ending with a hyphen");
const name = z.string().trim().min(1).max(100);
const about = z.string().trim().max(5000).nullable().optional();

// .strict(): logo ids are not accepted until media wiring lands.
const createSchema = z.object({ name, slug: slug.optional(), about }).strict();
const updateSchema = z.object({ name: name.optional(), about }).strict();
const inviteSchema = z.object({ email: z.string().trim().email().max(254), roleKey: z.enum(INVITABLE_ROLE_KEYS) }).strict();
const acceptSchema = z.object({ token: z.string().min(20).max(200) }).strict();

const metaOf = (req: Request): MutationMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

@Controller("orgs")
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  @RequirePermission("org.create")
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.orgs.create(user.id, createSchema.parse(body), metaOf(req));
  }

  @Public()
  @Get(":slug")
  get(@Param("slug") slug: string) {
    return this.orgs.get(slug);
  }

  @Patch(":slug")
  @RequirePermission("org.manage", { orgParam: "slug" })
  update(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Body() body: unknown, @Req() req: Request) {
    return this.orgs.update(user.id, slug, updateSchema.parse(body), metaOf(req));
  }

  @Post(":slug/invites")
  @RequirePermission("org.invite", { orgParam: "slug" })
  invite(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Body() body: unknown, @Req() req: Request) {
    return this.orgs.invite(user.id, slug, inviteSchema.parse(body), metaOf(req));
  }

  @Get(":slug/members")
  @RequirePermission("org.manage", { orgParam: "slug" })
  members(@Param("slug") slug: string, @Query() query: { cursor?: unknown; limit?: unknown }) {
    return this.orgs.members(slug, parsePage(query));
  }

  @Delete(":slug/members/:userId")
  @HttpCode(204)
  @RequirePermission("org.manage", { orgParam: "slug" })
  async removeMember(@CurrentUser() user: AuthUser, @Param("slug") slug: string, @Param("userId") userId: string, @Req() req: Request) {
    await this.orgs.removeMember(user.id, slug, userId, metaOf(req));
  }
}

@Controller("org-invites")
export class OrgInvitesController {
  constructor(private readonly orgs: OrganizationsService) {}

  @AuthenticatedOnly()
  @Post("accept")
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.orgs.accept(user.id, acceptSchema.parse(body).token, metaOf(req));
  }
}
