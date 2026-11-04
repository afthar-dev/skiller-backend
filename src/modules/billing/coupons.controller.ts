import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { parsePage } from "../../common/http/pagination";
import { ApiErrorResponse } from "../../common/openapi/error-response";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RequireStepUp } from "../identity";
import { ProfilesService } from "../users";
import { RequirePermission } from "../rbac";
import { CouponsAdminService, type CouponPatch, type NewCoupon } from "./coupons-admin.service";
import { fromApi } from "./money";
import { metaOf } from "./wallet.controller";

const code = z.string().trim().min(3).max(32);
const value = z.string().regex(/^[1-9]\d{0,14}$/, 'a whole number as a string: basis points for PERCENT (2000 = 20%), paise for FLAT, e.g. "5000"');
const common = {
  code,
  kind: z.enum(["PERCENT", "FLAT"]),
  value,
  itemType: z.string().trim().min(1).max(40).optional(),
  itemId: z.string().trim().min(1).max(100).optional(),
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
  expiresAt: z.string().datetime().optional(),
};
const platformBody = z
  .object({ ...common, scope: z.enum(["ALL", "SELLER", "ITEM"]).optional(), ownerType: z.enum(["USER", "ORG"]).optional(), ownerId: z.string().trim().min(1).max(100).optional() })
  .strict();
const mineBody = z.object({ ...common, scope: z.enum(["SELLER", "ITEM"]).optional() }).strict();
const patchBody = z
  .object({ isActive: z.boolean().optional(), maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(), expiresAt: z.string().datetime().nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "send at least one field to change");

const toNew = (b: z.infer<typeof platformBody>): NewCoupon => {
  let amount: bigint;
  try {
    amount = fromApi(b.value);
  } catch {
    throw new AppError("VALIDATION_FAILED", 400, "value must be a whole number");
  }
  return { code: b.code, kind: b.kind, value: amount, scope: b.scope, ownerType: b.ownerType, ownerId: b.ownerId, itemType: b.itemType, itemId: b.itemId, maxUses: b.maxUses, expiresAt: b.expiresAt ? new Date(b.expiresAt) : undefined };
};
const toPatch = (b: z.infer<typeof patchBody>): CouponPatch => ({ isActive: b.isActive, maxUses: b.maxUses, expiresAt: b.expiresAt === undefined ? undefined : b.expiresAt === null ? null : new Date(b.expiresAt) });

@ApiTags("Admin")
@Controller("admin/coupons")
export class AdminCouponsController {
  constructor(private readonly coupons: CouponsAdminService) {}

  @Get()
  @RequirePermission("billing.coupons.manage")
  @ApiOperation({ summary: "Platform-funded coupons, newest first (`active=true|false`, `code=` prefix)" })
  @ApiPagination()
  list(@Query() query: Record<string, unknown>) {
    const active = query.active === "true" ? true : query.active === "false" ? false : undefined;
    return this.coupons.listPlatform({ active, code: typeof query.code === "string" ? query.code : undefined }, parsePage(query));
  }

  @Post()
  @RequirePermission("billing.coupons.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Create a platform-funded coupon: for everything, one seller, or one item (step-up required, audited)" })
  @ApiZodBody(platformBody)
  @ApiErrorResponse(409, "COUPON_CODE_TAKEN")
  @ApiErrorResponse(422, "COUPON_INVALID: the combination of scope, owner and item is not allowed.")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    return this.coupons.createPlatform(user.id, toNew(platformBody.parse(body)), metaOf(req));
  }

  @Patch(":id")
  @RequirePermission("billing.coupons.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Switch a platform coupon on or off, or change its use limit or expiry (code, kind and value never change; step-up required, audited)" })
  @ApiZodBody(patchBody)
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.coupons.updatePlatform(user.id, id, toPatch(patchBody.parse(body)), metaOf(req));
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("billing.coupons.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Delete a platform coupon that was never used (step-up required, audited). A used coupon is switched off instead." })
  @ApiErrorResponse(409, "COUPON_IN_USE")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    await this.coupons.deletePlatform(user.id, id, metaOf(req));
  }
}

/** A creator's own coupons: for all of their items (SELLER) or one of them (ITEM). Needs a plan that includes creator coupons. */
@ApiTags("Coupons")
@Controller("coupons/mine")
export class CreatorCouponsController {
  constructor(
    private readonly coupons: CouponsAdminService,
    private readonly profiles: ProfilesService,
  ) {}

  private async creator(user: AuthUser): Promise<string> {
    if (!(await this.profiles.isCreator(user.id))) throw new AppError("CREATOR_REQUIRED", 403, "Only creators have coupons");
    return user.id;
  }

  @AuthenticatedOnly()
  @Get()
  @ApiOperation({ summary: "My coupons, newest first" })
  @ApiPagination()
  async list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.coupons.listMine(await this.creator(user), parsePage(query));
  }

  @AuthenticatedOnly()
  @Post()
  @ApiOperation({ summary: "Create a coupon for my items. Discounts come out of my share; the plan must include creator coupons" })
  @ApiZodBody(mineBody)
  @ApiErrorResponse(403, "CREATOR_REQUIRED, or ENTITLEMENT_LIMIT_REACHED when the plan has no creator coupons.")
  @ApiErrorResponse(409, "COUPON_CODE_TAKEN")
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const userId = await this.creator(user);
    return this.coupons.createMine(userId, toNew(mineBody.parse(body)));
  }

  @AuthenticatedOnly()
  @Patch(":id")
  @ApiOperation({ summary: "Switch one of my coupons on or off, or change its use limit or expiry" })
  @ApiZodBody(patchBody)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.coupons.updateMine(await this.creator(user), id, toPatch(patchBody.parse(body)));
  }

  @AuthenticatedOnly()
  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete one of my coupons that was never used (a used one is switched off instead)" })
  @ApiErrorResponse(409, "COUPON_IN_USE")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.coupons.deleteMine(await this.creator(user), id);
  }
}
