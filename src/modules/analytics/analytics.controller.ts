import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { ApiResult } from "../../common/openapi/money";
import { ApiCsv } from "../../common/openapi/responses";
import { RequireStepUp } from "../identity";
import { RequirePermission } from "../rbac";
import { analyticsCsvDescription } from "../../common/openapi/admin";
import { AnalyticsService } from "./analytics.service";
import { RebuildService, type ActionMeta } from "./rebuild.service";

const metaOf = (req: Request): ActionMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const FROM = { name: "from", required: false, description: "First IST day, YYYY-MM-DD (default: 29 days before `to`)" } as const;
const TO = { name: "to", required: false, description: "Last IST day, inclusive, YYYY-MM-DD (default: today). At most 731 days from `from`." } as const;
const KEYS = { name: "keys", required: true, description: "Comma-separated metric keys (see `metrics[].key` in the overview)" } as const;

const rebuildBody = z.object({ from: z.string(), to: z.string() }).strict();

@ApiTags("Admin analytics")
@Controller("admin/analytics")
@RequirePermission("analytics.view")
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly rebuilds: RebuildService,
  ) {}

  @Get("overview")
  @ApiOperation({
    summary:
      "Every dashboard number for a range of IST days: signups, new creators, DAU / WAU / MAU (approximate: HyperLogLog), orders, GMV, platform revenue, refunds, payouts, paid subscribers, enrolments, completions, certificates, reels, gigs, inquiries, campaign sends / opens / clicks and reports. Flow metrics are summed; levels and active-member counts show the last day's value (`asOf`). Money is a decimal string of paise. Numbers come from the nightly rollup (03:00 IST); `dataThrough` is the newest rolled-up day",
  })
  @ApiQuery(FROM)
  @ApiQuery(TO)
  @ApiErrorResponse(400, "ANALYTICS_RANGE_INVALID: bad dates, from after to, or more than 2 years.")
  @ApiResult(200, "AnalyticsOverview")
  overview(@Query() query: Record<string, unknown>) {
    return this.analytics.overview(this.analytics.range(str(query.from), str(query.to)));
  }

  @Get("series")
  @ApiOperation({ summary: "A daily series (one point per IST day, 0 for a day not yet rolled up) for the chosen metric keys" })
  @ApiQuery(KEYS)
  @ApiQuery(FROM)
  @ApiQuery(TO)
  @ApiErrorResponse(400, "ANALYTICS_RANGE_INVALID, ANALYTICS_UNKNOWN_METRIC")
  @ApiResult(200, "AnalyticsSeries")
  series(@Query() query: Record<string, unknown>) {
    return this.analytics.series(this.analytics.keys(str(query.keys)), this.analytics.range(str(query.from), str(query.to)));
  }

  @Get("funnel")
  @ApiOperation({ summary: "Signup, creator, first published course or gig, first sale: absolute counts for the range from the rollup. Not a cohort and no member data" })
  @ApiQuery(FROM)
  @ApiQuery(TO)
  @ApiResult(200, "AnalyticsFunnel")
  funnel(@Query() query: Record<string, unknown>) {
    return this.analytics.funnel(this.analytics.range(str(query.from), str(query.to)));
  }

  @Get("export")
  @ApiOperation({ summary: "The same daily series as a CSV file (attachment). Money columns are paise. Text cells are protected against spreadsheet formulas" })
  @ApiQuery(KEYS)
  @ApiQuery(FROM)
  @ApiQuery(TO)
  @ApiCsv(analyticsCsvDescription)
  async export(@Query() query: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<string> {
    const { filename, body } = await this.analytics.csv(this.analytics.keys(str(query.keys)), this.analytics.range(str(query.from), str(query.to)));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return body;
  }

  @Post("rebuild")
  @HttpCode(202)
  @RequireStepUp()
  @ApiOperation({ summary: "Rebuild the rollup for past IST days (at most 31, up to yesterday) as a background job; rerunning a day overwrites it, never doubles it. Step-up required, audited" })
  @ApiZodBody(rebuildBody)
  @ApiErrorResponse(400, "ANALYTICS_RANGE_INVALID: bad dates, from after to, today or later, or more than 31 days.")
  @ApiResult(202, "AnalyticsRebuildAccepted", "The rebuild was queued.")
  rebuild(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { from, to } = rebuildBody.parse(body);
    return this.rebuilds.request(user.id, this.analytics.rebuildRange(from, to), metaOf(req));
  }
}
