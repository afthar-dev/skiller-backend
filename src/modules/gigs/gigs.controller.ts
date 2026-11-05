import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { ViewerResolver } from "../identity";
import { GigsPublicService } from "./gigs-public.service";

/** Public reads: generous per-IP cap, enough for browsing. */
export const gigReadLimit = () => RateLimit({ key: (req) => `gigs:read:${req.ip}`, limit: 300, windowSec: 60 });

@ApiTags("Gigs")
@Controller()
export class GigsController {
  constructor(
    private readonly gigs: GigsPublicService,
    private readonly viewer: ViewerResolver,
  ) {}

  @Public()
  @gigReadLimit()
  @Get("gigs/:slug")
  @ApiOperation({ summary: "A live gig: seller, packages, gallery, FAQs and `paymentNotice` (payments happen outside Skiller and are not protected; show it as given). 404 for anything not live or not visible to you" })
  async get(@Param("slug") slug: string, @Req() req: Request) {
    return this.gigs.page(slug, await this.viewer.viewerId(req));
  }

  @Public()
  @gigReadLimit()
  @Get("profiles/:handle/gigs")
  @ApiOperation({ summary: "A seller's live gigs, newest first" })
  @ApiPagination()
  async byHandle(@Param("handle") handle: string, @Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.gigs.byHandle(handle, parsePage(query), await this.viewer.viewerId(req));
  }
}
