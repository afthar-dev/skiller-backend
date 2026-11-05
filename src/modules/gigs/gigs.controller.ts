import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { ViewerResolver } from "../identity";
import { GIG_SORTS, GigCatalogService } from "./gig-catalog.service";
import { GigsPublicService } from "./gigs-public.service";

const paise = z.string().regex(/^[0-9]{1,12}$/, "integer paise as a decimal string, e.g. \"49900\"").transform((v) => BigInt(v));

const querySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z.string().regex(/^[a-z0-9-]{1,60}$/, "a category slug").optional(),
    minPrice: paise.optional(),
    maxPrice: paise.optional(),
    sort: z.enum(GIG_SORTS).default("relevance"),
  })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, { path: ["minPrice"], message: "must not exceed maxPrice" });

/** Public reads: generous per-IP cap, enough for browsing. */
export const gigReadLimit = () => RateLimit({ key: (req) => `gigs:read:${req.ip}`, limit: 300, windowSec: 60 });

@ApiTags("Gigs")
@Controller()
export class GigsController {
  constructor(
    private readonly gigs: GigsPublicService,
    private readonly catalog: GigCatalogService,
    private readonly viewer: ViewerResolver,
  ) {}

  @Public()
  @gigReadLimit()
  @Get("gigs")
  @ApiOperation({
    summary:
      "Search and browse live gigs. q is full-text over title, tags and description, with fuzzy title matching when nothing matches as written; category is a course category slug; minPrice / maxPrice filter the starting (lowest package) price in paise; sort relevance (newest without q), newest, price_asc or price_desc. Gigs of suspended sellers, blocked sellers and anything not live are never listed",
  })
  @ApiPagination()
  async list(@Query() query: Record<string, unknown>, @Req() req: Request) {
    const filters = querySchema.parse(query);
    const page = parsePage(query);
    return this.catalog.search({ ...filters, cursor: page.cursor, limit: page.limit }, await this.viewer.viewerId(req));
  }

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
