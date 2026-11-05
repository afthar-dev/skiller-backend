import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { HASHTAG_SORTS, HashtagReelsService } from "./hashtag-reels.service";
import { HashtagTrending } from "./hashtag-trending";
import { ReelSearchService } from "./reel-search.service";
import { reelReadLimit } from "./reels.controller";
import { ViewerResolver } from "./viewer";

const sortSchema = z.enum(HASHTAG_SORTS).default("top");

@ApiTags("Reels")
@Controller("hashtags")
export class HashtagsController {
  constructor(
    private readonly hashtagReels: HashtagReelsService,
    private readonly trending: HashtagTrending,
    private readonly viewer: ViewerResolver,
  ) {}

  @Public()
  @reelReadLimit()
  @Get("trending")
  @ApiOperation({ summary: "The 20 hashtags whose use grew most in the last 24 hours compared with the 24 hours before (recomputed hourly)" })
  trendingTags() {
    return this.trending.current();
  }

  @Public()
  @reelReadLimit()
  @Get(":tag/reels")
  @ApiOperation({ summary: "Published reels with a hashtag: `sort=top` (engagement, default) or `sort=recent`. The tag may be written with or without #, in any case" })
  @ApiQuery({ name: "sort", required: false, enum: HASHTAG_SORTS })
  @ApiPagination()
  async reels(@Param("tag") tag: string, @Query() query: Record<string, unknown>, @Req() req: Request) {
    const sort = sortSchema.parse(query.sort ?? undefined);
    return this.hashtagReels.reels(tag, sort, parsePage(query), await this.viewer.viewerId(req));
  }
}

/** Declared before ReelsController in the module: `reels/search` must be matched before `reels/:id`. */
@ApiTags("Reels")
@Controller("reels")
export class ReelSearchController {
  constructor(
    private readonly search: ReelSearchService,
    private readonly viewer: ViewerResolver,
  ) {}

  @Public()
  @reelReadLimit()
  @Get("search")
  @ApiOperation({ summary: "Search published reels by caption and hashtag (newest matches first). Falls back to fuzzy matching on the caption when no word matches. Empty text gives an empty page" })
  @ApiQuery({ name: "q", required: true, type: String, description: "Search text, up to 100 characters." })
  @ApiPagination()
  async find(@Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.search.search(query.q, parsePage(query), await this.viewer.viewerId(req));
  }
}
