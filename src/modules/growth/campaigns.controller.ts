import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { sanitizeSingleLine } from "../courses";
import { ApiResult, ApiPageResult } from "../../common/openapi/money";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import { CampaignsService, type ActionMeta } from "./campaigns.service";
import { segmentSchema } from "./segment";

const metaOf = (req: Request): ActionMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

const name = z.preprocess((v) => (typeof v === "string" ? sanitizeSingleLine(v, 400) : v), z.string().min(1).max(100));
/** The subject is plain text on one line: control characters (line breaks included) are refused, not repaired. */
const subject = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .refine((v) => !/[\p{C}\p{Zl}\p{Zp}]/u.test(v), "must be plain text on one line");

const createSchema = z.object({ name, subject, bodyMarkdown: z.string().min(1).max(50_000), segment: segmentSchema.default({}) }).strict();
const updateSchema = z
  .object({ name: name.optional(), subject: subject.optional(), bodyMarkdown: z.string().min(1).max(50_000).optional(), segment: segmentSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Send at least one field to change" });
const sendSchema = z.object({ scheduledAt: z.string().datetime().optional() }).strict();
const statusSchema = z.enum(["DRAFT", "SCHEDULED", "SENDING", "PAUSED", "SENT", "CANCELLED"]).optional();

@ApiTags("Campaigns")
@Controller("admin/campaigns")
@RequirePermission("campaign.manage")
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post()
  @RequireStepUp()
  @ApiOperation({ summary: "Create a draft promo campaign: subject (plain text, 150), Markdown body, segment (roles, plan, interests, lastActive, hasPurchased). The unsubscribe footer is added to every mail and cannot be removed" })
  @ApiZodBody(createSchema)
  @ApiResult(201, "Campaign", "The new draft.")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.campaigns.create(user.id, createSchema.parse(body), metaOf(req));
  }

  @Get()
  @ApiOperation({ summary: "List campaigns, newest first" })
  @ApiPagination()
  @ApiPageResult("Campaign")
  list(@Query() query: Record<string, unknown>) {
    return this.campaigns.list(parsePage(query), statusSchema.parse(query.status || undefined));
  }

  @Get(":id")
  @ApiOperation({ summary: "A campaign with its stats (delivered, opened, clicked, bounced, complained) and recipient counts by state; no member data" })
  @ApiResult(200, "CampaignDetail")
  get(@Param("id") id: string) {
    return this.campaigns.get(id);
  }

  @Patch(":id")
  @RequireStepUp()
  @ApiOperation({ summary: "Edit a draft campaign (an edit withdraws any approval)" })
  @ApiZodBody(updateSchema)
  @ApiResult(200, "Campaign")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.campaigns.update(user.id, id, updateSchema.parse(body), metaOf(req));
  }

  @Post(":id/preview")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "How many active members the segment matches right now, whether sending needs a second admin (more than 10,000), and the mail as members will get it (subject and HTML from the sender's own renderer). Counts and the mail only, no member data" })
  @ApiResult(200, "CampaignPreview")
  preview(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.campaigns.preview(user.id, id);
  }

  @Post(":id/test-send")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "Send this campaign, marked [Test], to your own address only (no recipient can be named)" })
  @ApiResult(200, "CampaignTestSent")
  testSend(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.campaigns.testSend(user.id, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "Approve a draft campaign that reaches more than 10,000 members. Not the creator" })
  @ApiResult(200, "Campaign")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.campaigns.approve(user.id, id, metaOf(req));
  }

  @Post(":id/send")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "Send now, or at scheduledAt. Above 10,000 members it must be approved by another admin first (409 CAMPAIGN_APPROVAL_REQUIRED)" })
  @ApiZodBody(sendSchema)
  @ApiResult(200, "Campaign")
  send(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    const { scheduledAt } = sendSchema.parse(body ?? {});
    return this.campaigns.send(user.id, id, scheduledAt ? new Date(scheduledAt) : undefined, metaOf(req));
  }

  @Post(":id/pause")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "Pause a campaign that is sending (it stops after the current batch)" })
  @ApiResult(200, "Campaign")
  pause(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.campaigns.pause(user.id, id, metaOf(req));
  }

  @Post(":id/resume")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "Resume a paused campaign" })
  @ApiResult(200, "Campaign")
  resume(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.campaigns.resume(user.id, id, metaOf(req));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequireStepUp()
  @ApiOperation({ summary: "Cancel a campaign that has not finished; members it did not reach are skipped" })
  @ApiResult(200, "Campaign")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.campaigns.cancel(user.id, id, metaOf(req));
  }
}
