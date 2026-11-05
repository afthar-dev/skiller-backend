import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { sanitizePlainText, sanitizeSingleLine } from "../courses";
import { RequirePermission } from "../rbac";
import {
  DESCRIPTION_MAX,
  FAQ_ANSWER_MAX,
  FAQ_QUESTION_MAX,
  FAQS_MAX,
  FEATURE_MAX,
  FEATURES_MAX,
  GALLERY_MAX,
  GIG_TIERS,
  MAX_DELIVERY_DAYS,
  MAX_REVISIONS,
  PACKAGE_DESCRIPTION_MAX,
  PACKAGE_NAME_MAX,
  TAG_MAX,
  TAGS_MAX,
  TITLE_MAX,
  TITLE_MIN,
} from "./gig-rules";
import { GigsService, type ActionMeta } from "./gigs.service";

/** A one-line plain-text field: sanitised first, then held to min / max of what is left. */
const line = (min: number, max: number) => z.preprocess((v) => (typeof v === "string" ? sanitizeSingleLine(v, max * 4) : v), z.string().min(min).max(max));
/** Plain text that may keep line breaks. */
const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? sanitizePlainText(v, max * 4) : v), z.string().max(max));

const price = z.string().regex(/^\d{1,12}$/, 'integer paise as a decimal string, e.g. "49900"').transform((v) => BigInt(v));
const assetId = z.string().uuid();

const packageSchema = z
  .object({
    tier: z.enum(GIG_TIERS),
    name: line(1, PACKAGE_NAME_MAX),
    description: text(PACKAGE_DESCRIPTION_MAX).default(""),
    pricePaise: price,
    deliveryDays: z.number().int().min(1).max(MAX_DELIVERY_DAYS),
    revisions: z.number().int().min(0).max(MAX_REVISIONS),
    features: z.array(line(1, FEATURE_MAX)).max(FEATURES_MAX).default([]),
  })
  .strict();

/** One to three packages, one per tier, BASIC always among them. */
const packages = z
  .array(packageSchema)
  .min(1)
  .max(3)
  .superRefine((list, ctx) => {
    const tiers = list.map((p) => p.tier);
    if (new Set(tiers).size !== tiers.length) ctx.addIssue({ code: "custom", message: "one package per tier" });
    if (!tiers.includes("BASIC")) ctx.addIssue({ code: "custom", message: "a BASIC package is required" });
  });

const tags = z
  .array(z.string().trim().toLowerCase().min(1).max(TAG_MAX))
  .max(TAGS_MAX)
  .transform((list) => [...new Set(list)]);
const faqs = z.array(z.object({ question: line(1, FAQ_QUESTION_MAX), answer: text(FAQ_ANSWER_MAX).pipe(z.string().min(1)) }).strict()).max(FAQS_MAX);
const gallery = z
  .array(assetId)
  .max(GALLERY_MAX)
  .refine((list) => new Set(list).size === list.length, "each picture once");

const fields = {
  title: line(TITLE_MIN, TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX),
  categoryId: z.string().uuid(),
  tags,
  packages,
  faqs,
  coverAssetId: assetId.nullable(),
  galleryAssetIds: gallery,
};

const createSchema = z
  .object({ title: fields.title, description: fields.description.default(""), categoryId: fields.categoryId, tags: fields.tags.default([]), packages: fields.packages, faqs: fields.faqs.default([]), coverAssetId: fields.coverAssetId.optional(), galleryAssetIds: fields.galleryAssetIds.optional() })
  .strict();
const updateSchema = z
  .object({
    title: fields.title.optional(),
    description: fields.description.optional(),
    categoryId: fields.categoryId.optional(),
    tags: fields.tags.optional(),
    packages: fields.packages.optional(),
    faqs: fields.faqs.optional(),
    coverAssetId: fields.coverAssetId.optional(),
    galleryAssetIds: fields.galleryAssetIds.optional(),
  })
  .strict();

const listQuery = z.object({ status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "HIDDEN", "REMOVED"]).optional() });

const metaOf = (req: Request): ActionMeta => ({ ip: req.ip, requestId: (req as Request & { id?: string }).id });

@ApiTags("Gig studio")
@Controller("studio/gigs")
export class StudioGigsController {
  constructor(private readonly gigs: GigsService) {}

  @RequirePermission("gig.create")
  @Post()
  @ApiOperation({ summary: "Create a draft gig: one to three packages (BASIC required, prices 99 to 10,00,000 rupees as paise strings), FAQs, tags, optional cover and gallery pictures" })
  @ApiZodBody(createSchema)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.gigs.create(user.id, createSchema.parse(body));
  }

  @RequirePermission("gig.create")
  @Get()
  @ApiOperation({ summary: "Your gigs, newest first (deleted ones are left out)" })
  @ApiPagination()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    const { status } = listQuery.parse({ status: query.status || undefined });
    return this.gigs.list(user.id, parsePage(query), status);
  }

  @RequirePermission("gig.create")
  @Get(":id")
  @ApiOperation({ summary: "One of your gigs, in any state" })
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.gigs.get(user.id, id);
  }

  @RequirePermission("gig.create")
  @Patch(":id")
  @ApiOperation({ summary: "Edit a gig (packages, FAQs and gallery are replaced as a whole). A live gig must stay complete. Not while it is hidden or removed by moderation" })
  @ApiZodBody(updateSchema)
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.gigs.update(user.id, id, updateSchema.parse(body));
  }

  @RequirePermission("gig.create")
  @Post(":id/activate")
  @HttpCode(200)
  @ApiOperation({ summary: "Put a draft or paused gig live (GIG_NOT_PUBLISHABLE lists what is missing; ENTITLEMENT_LIMIT_REACHED when the plan's max_active_gigs is full). Live already is a no-op" })
  activate(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.gigs.activate(user.id, id, metaOf(req));
  }

  @RequirePermission("gig.create")
  @Post(":id/pause")
  @HttpCode(200)
  @ApiOperation({ summary: "Take a live gig off every public surface and free its plan slot. Paused already is a no-op" })
  pause(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.gigs.pause(user.id, id, metaOf(req));
  }

  @RequirePermission("gig.create")
  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a gig (soft delete: it disappears everywhere and its pictures are released)" })
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    await this.gigs.remove(user.id, id, metaOf(req));
  }
}
