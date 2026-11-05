import { Controller, Get, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { FeedsService } from "./feeds.service";
import { ViewerResolver } from "../identity";

@ApiTags("Reels")
@Controller("feed")
export class FeedsController {
  constructor(
    private readonly feeds: FeedsService,
    private readonly viewer: ViewerResolver,
  ) {}

  @AuthenticatedOnly()
  @Get("following")
  @ApiOperation({ summary: "Published reels of the creators I follow, newest first. 120 requests a minute" })
  @ApiPagination()
  following(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.feeds.following(user.id, parsePage(query));
  }

  @Public()
  @Get("for-you")
  @ApiOperation({
    summary:
      "Recommended reels: recency x engagement x my interests (signed out: the same without interests, shared for five minutes). A first page (no cursor) ranks and starts a 30-minute session; its cursors page through that ranking with no duplicates or skips. `refreshed: true` means the session in the cursor had expired and this page starts a new ranking. 120 requests a minute per user or IP",
  })
  @ApiPagination()
  async forYou(@Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.feeds.forYou(await this.viewer.viewerId(req), req.ip ?? "unknown", parsePage(query));
  }
}
