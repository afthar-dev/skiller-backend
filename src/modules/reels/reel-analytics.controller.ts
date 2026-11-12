import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { ApiResult } from "../../common/openapi/money";
import { ReelAnalyticsService } from "./reel-analytics.service";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD (IST calendar day)");
const querySchema = z.object({ from: date.optional(), to: date.optional() }).strict();
/** An empty `?from=` means "not given". */
const parseQuery = (query: Record<string, unknown>) => querySchema.parse(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== "" && v !== undefined)));

const FROM = { name: "from", required: false, description: "First IST day, YYYY-MM-DD (default: 29 days before `to`)" } as const;
const TO = { name: "to", required: false, description: "Last IST day, inclusive, YYYY-MM-DD (default: today). At most 366 days from `from`." } as const;

@ApiTags("Reel studio")
@Controller("studio/reels")
export class ReelAnalyticsController {
  constructor(private readonly analytics: ReelAnalyticsService) {}

  // AuthenticatedOnly: the numbers are always the caller's own reels.
  @AuthenticatedOnly()
  @Get("analytics")
  @ApiOperation({
    summary:
      "My reels' totals over a range of IST days: views, approximate unique viewers, average watch %, link clicks to the linked course, new followers, live likes / comments / saves / shares. Standard and advanced plans also get a daily series and the top reels; on basic `upgradeRequired` is true",
  })
  @ApiResult(200, "CreatorReelAnalytics")
  @ApiQuery(FROM)
  @ApiQuery(TO)
  account(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.analytics.forCreator(user.id, parseQuery(query));
  }

  @AuthenticatedOnly()
  @Get(":id/analytics")
  @ApiOperation({
    summary:
      "One of my reels over a range of IST days (owner only): views, approximate unique viewers, average watch %, link clicks, live likes / comments / saves / shares, and the creator's new followers (`newFollowers`, not attributed to the reel). Standard and advanced plans also get the daily series",
  })
  @ApiResult(200, "SingleReelAnalytics")
  @ApiQuery(FROM)
  @ApiQuery(TO)
  one(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    return this.analytics.forReel(user.id, id, parseQuery(query));
  }
}
