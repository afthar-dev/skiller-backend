import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/auth/public.decorator";
import { ApiJsonResponse } from "../../common/openapi/responses";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { PublicSitemapService } from "./public-sitemap.service";
import { sitemapPageSchema } from "./public-sitemap.responses";
import { isSitemapKind, SITEMAP_KINDS, sitemapKindNotFound } from "./sitemap-rules";

@ApiTags("Public sitemap")
@Controller("public/sitemap")
export class PublicSitemapController {
  constructor(private readonly sitemap: PublicSitemapService) {}

  @Public()
  @Get(":kind")
  @RateLimit({ key: (req) => `sitemap:${req.ip}`, limit: 120, windowSec: 60 })
  @ApiOperation({
    summary:
      "Public pages of one kind for the web sitemap, ordered by slug, 1,000 per page. Only what is public right now: published course, live gig of an active seller, active profile with something to show, active category with a public course, hashtag on a published reel",
  })
  @ApiParam({ name: "kind", enum: SITEMAP_KINDS })
  @ApiQuery({ name: "cursor", required: false, type: String, description: "`nextCursor` from the previous page." })
  @ApiJsonResponse(200, "A page of slugs with their last update; nextCursor is null on the last page. A profile's slug is its handle, a hashtag's its tag (without #).", sitemapPageSchema)
  page(@Param("kind") kind: string, @Query("cursor") cursor?: string) {
    if (!isSitemapKind(kind)) throw sitemapKindNotFound();
    return this.sitemap.page(kind, typeof cursor === "string" && cursor.length > 0 ? cursor : undefined);
  }
}
