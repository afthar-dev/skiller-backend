import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiJsonResponse } from "../../common/openapi/responses";
import { ApiPagination, ApiZodQuery } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { CATALOG_SORTS, CatalogService } from "./catalog.service";
import { catalogPageSchema } from "./course-responses";
import { CourseThumbnails } from "./course-thumbnails";
import { COURSE_LANGUAGES, COURSE_LEVELS } from "./course-rules";

const paise = z.string().regex(/^\d{1,12}$/, "integer paise as a decimal string, e.g. \"49900\"").transform((v) => BigInt(v));

const queryObject = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().regex(/^[a-z0-9-]{1,60}$/, "a category slug").optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  language: z.enum(COURSE_LANGUAGES).optional(),
  price: z.enum(["free", "paid"]).optional(),
  minPrice: paise.optional(),
  maxPrice: paise.optional(),
  minRating: z.coerce.number().min(1).max(5).optional(),
  sort: z.enum(CATALOG_SORTS).default("relevance"),
});
const querySchema = queryObject.refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, { path: ["minPrice"], message: "must not exceed maxPrice" });

@ApiTags("Courses")
@Controller("courses")
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly thumbnails: CourseThumbnails,
  ) {}

  @Public()
  @Get()
  @RateLimit({ key: (req) => `catalog:${req.ip}`, limit: 120, windowSec: 60 })
  @ApiOperation({
    summary:
      "Search and browse published courses. q is full-text over title, subtitle, tags, description and the creator's name, with fuzzy title matching when nothing matches as written; filters combine; sort relevance (popular without q), newest, rating or popular (enrolments of the last 30 days); price filters in paise",
  })
  @ApiZodQuery(queryObject)
  @ApiPagination()
  @ApiJsonResponse(200, "A page of published courses; nextCursor is null on the last page.", catalogPageSchema)
  async list(@Query() query: Record<string, unknown>) {
    const filters = querySchema.parse(query);
    const page = parsePage(query);
    const found = await this.catalog.search({ ...filters, cursor: page.cursor, limit: page.limit });
    return { ...found, items: await this.thumbnails.withUrls(found.items) };
  }
}
