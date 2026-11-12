import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { parsePage } from "../../common/http/pagination";
import { ApiResult } from "../../common/openapi/money";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RequirePermission } from "../rbac";
import { DECISION_NOTE_MAX, ModerationService, NOTE_MAX, REPORT_REASONS, REPORT_TARGET_TYPES, type ActionMeta } from "./moderation.service";
import type { ReportTargetType } from "@prisma/client";

const reportSchema = z
  .object({ targetType: z.enum(REPORT_TARGET_TYPES), targetId: z.string().min(1).max(64), reason: z.enum(REPORT_REASONS), note: z.string().max(NOTE_MAX).optional() })
  .strict();
const decisionSchema = z.object({ note: z.string().trim().min(1).max(DECISION_NOTE_MAX) }).strict();

const metaOf = (user: AuthUser, req: Request): ActionMeta => ({ actorId: user.id, ip: req.ip, requestId: (req as Request & { id?: string }).id });

/** `reel`, `REEL_COMMENT`, `course-review` ... all name a target type. */
function parseType(raw: string): ReportTargetType {
  const type = raw.trim().toUpperCase().replace(/-/g, "_");
  if (!(REPORT_TARGET_TYPES as readonly string[]).includes(type)) throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { type: [`one of ${REPORT_TARGET_TYPES.join(", ")}`] } });
  return type as ReportTargetType;
}

@ApiTags("Moderation")
@Controller()
export class ReportsController {
  constructor(private readonly moderation: ModerationService) {}

  @AuthenticatedOnly()
  @Post("reports")
  @ApiOperation({ summary: "Report a reel, reel comment, course review, course Q&A item, a live gig (GIG) or a message you received (GIG_MESSAGE: only the other person in the conversation can). One report per member per item (repeating it answers 200 and changes nothing); not your own content; 20 reports an hour. Enough distinct reporters hide the item until a moderator decides" })
  @ApiResult(201, "ReportReceipt", "The report was recorded.")
  @ApiResult(200, "ReportReceipt", "This member had already reported the item; nothing changed.")
  @ApiZodBody(reportSchema)
  async report(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { id, created } = await this.moderation.report(user.id, reportSchema.parse(body));
    if (!created) res.status(200);
    return { id, reported: true };
  }
}

@ApiTags("Moderation")
@Controller("admin/moderation")
export class AdminModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @RequirePermission("moderation.review")
  @Get("reports")
  @ApiOperation({ summary: "Open reports grouped by content, longest waiting first" })
  @ApiPagination()
  queue(@Query() query: Record<string, unknown>) {
    const type = typeof query.type === "string" && query.type ? parseType(query.type) : undefined;
    return this.moderation.queue({ type }, parsePage(query));
  }

  @RequirePermission("moderation.review")
  @Post("targets/:type/:id/uphold")
  @HttpCode(200)
  @ApiOperation({ summary: "Uphold the reports: the content is removed, the author gets one strike (three active strikes bar posting for 7 days). Not for your own content or courses" })
  @ApiZodBody(decisionSchema)
  uphold(@CurrentUser() user: AuthUser, @Param("type") type: string, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.uphold(metaOf(user, req), parseType(type), id, decisionSchema.parse(body).note);
  }

  @RequirePermission("moderation.review")
  @Post("targets/:type/:id/dismiss")
  @HttpCode(200)
  @ApiOperation({ summary: "Dismiss the reports: content the threshold hid comes back, no strike" })
  @ApiZodBody(decisionSchema)
  dismiss(@CurrentUser() user: AuthUser, @Param("type") type: string, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.moderation.dismiss(metaOf(user, req), parseType(type), id, decisionSchema.parse(body).note);
  }
}
