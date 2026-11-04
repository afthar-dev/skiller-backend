import { Injectable } from "@nestjs/common";
import type { Coupon, CouponKind, CouponScope, Prisma, SellerOwnerType } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import type { MutationMeta } from "../rbac";
import { CouponsService, LIVE_REDEMPTION, normalizeCouponCode } from "./coupons.service";
import { toApi } from "./money";
import { SellableRegistry } from "./sellable.registry";

export interface CouponView {
  id: string;
  code: string;
  kind: CouponKind;
  /** PERCENT: basis points (2000 = 20%). FLAT: paise. A decimal string either way. */
  value: string;
  fundedBy: "PLATFORM" | "CREATOR";
  scope: CouponScope;
  ownerType: SellerOwnerType | null;
  ownerId: string | null;
  itemType: string | null;
  itemId: string | null;
  maxUses: number | null;
  expiresAt: string | null;
  isActive: boolean;
  /** Reserved or redeemed uses right now. */
  usedCount: number;
  createdAt: string;
}

export interface NewCoupon {
  code: string;
  kind: CouponKind;
  value: bigint;
  scope?: CouponScope;
  /** Platform coupons with scope SELLER: the seller they apply to. */
  ownerType?: SellerOwnerType;
  ownerId?: string;
  itemType?: string;
  itemId?: string;
  maxUses?: number;
  expiresAt?: Date;
}

export interface CouponPatch {
  isActive?: boolean;
  maxUses?: number | null;
  expiresAt?: Date | null;
}

type Row = Coupon & { _count: { redemptions: number } };

const toView = (c: Row): CouponView => ({
  id: c.id,
  code: c.code,
  kind: c.kind,
  value: toApi(c.value),
  fundedBy: c.fundedBy,
  scope: c.scope,
  ownerType: c.ownerType,
  ownerId: c.ownerId,
  itemType: c.itemType,
  itemId: c.itemId,
  maxUses: c.maxUses,
  expiresAt: c.expiresAt?.toISOString() ?? null,
  isActive: c.isActive,
  usedCount: c._count.redemptions,
  createdAt: c.createdAt.toISOString(),
});

const withCount = { _count: { select: { redemptions: { where: { status: { in: LIVE_REDEMPTION } } } } } } as const;
const notFound = () => new AppError("COUPON_NOT_FOUND", 404, "Coupon not found");

/**
 * Coupon management. Platform coupons (finance: `billing.coupons.manage`) and creator coupons (a creator's own, scope SELLER or ITEM) share
 * the validation in CouponsService.create; what differs is who may touch which rows. Code, kind and value never change after creation
 * (orders already priced against them); a coupon is switched off with isActive, and deleted only if nothing ever used it.
 */
@Injectable()
export class CouponsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponsService,
    private readonly registry: SellableRegistry,
    private readonly audit: AuditService,
  ) {}

  // ── platform coupons ───────────────────────────────────────────────────────────────────────────────────────────────

  async listPlatform(filter: { active?: boolean; code?: string }, page: PageQuery) {
    return this.list({ fundedBy: "PLATFORM", ...(filter.active === undefined ? {} : { isActive: filter.active }), ...(filter.code ? { code: { startsWith: normalizeCouponCode(filter.code) } } : {}) }, page);
  }

  async createPlatform(actorId: string, input: NewCoupon, meta: MutationMeta = {}): Promise<CouponView> {
    return this.prisma.$transaction(async (tx) => {
      const created = await this.coupons.create({ ...input, fundedBy: "PLATFORM", createdBy: actorId }, tx);
      const row = await tx.coupon.findUniqueOrThrow({ where: { id: created.id }, include: withCount });
      await this.audit.record(tx, { actorId, action: "coupon.create", targetType: "coupon", targetId: row.id, before: null, after: toView(row), ...meta });
      return toView(row);
    });
  }

  async updatePlatform(actorId: string, id: string, patch: CouponPatch, meta: MutationMeta = {}): Promise<CouponView> {
    return this.update({ id, fundedBy: "PLATFORM" }, patch, actorId, meta);
  }

  async deletePlatform(actorId: string, id: string, meta: MutationMeta = {}): Promise<void> {
    await this.remove({ id, fundedBy: "PLATFORM" }, actorId, meta);
  }

  // ── a creator's own coupons ────────────────────────────────────────────────────────────────────────────────────────

  async listMine(userId: string, page: PageQuery) {
    return this.list({ fundedBy: "CREATOR", ownerType: "USER", ownerId: userId }, page);
  }

  async createMine(userId: string, input: NewCoupon): Promise<CouponView> {
    const scope = input.scope ?? "SELLER";
    if (scope === "ALL") throw new AppError("COUPON_INVALID", 422, "A creator coupon applies to your own items: use scope SELLER or ITEM");
    if (scope === "ITEM") {
      const provider = input.itemType ? this.registry.find(input.itemType) : undefined;
      if (!provider || !input.itemId) throw new AppError("COUPON_INVALID", 422, "Unknown item type");
      const item = await provider.describe(input.itemId, { buyerId: userId });
      if (item.sellerOwnerType !== "USER" || item.sellerOwnerId !== userId) throw new AppError("COUPON_INVALID", 422, "You can only create coupons for your own items");
    }
    const created = await this.coupons.create({ ...input, scope, fundedBy: "CREATOR", ownerType: "USER", ownerId: userId, createdBy: userId });
    return toView(await this.prisma.coupon.findUniqueOrThrow({ where: { id: created.id }, include: withCount }));
  }

  async updateMine(userId: string, id: string, patch: CouponPatch): Promise<CouponView> {
    return this.update({ id, fundedBy: "CREATOR", ownerType: "USER", ownerId: userId }, patch, userId, {});
  }

  async deleteMine(userId: string, id: string): Promise<void> {
    await this.remove({ id, fundedBy: "CREATOR", ownerType: "USER", ownerId: userId }, userId, {});
  }

  // ── shared ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async list(where: Prisma.CouponWhereInput, page: PageQuery) {
    const rows = await this.prisma.coupon.findMany({ where: { ...where, ...(page.cursor ? { id: { lt: page.cursor } } : {}) }, orderBy: { id: "desc" }, take: page.limit + 1, include: withCount });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toView), nextCursor };
  }

  private async update(scope: Prisma.CouponWhereInput & { id: string }, patch: CouponPatch, actorId: string, meta: MutationMeta): Promise<CouponView> {
    if (patch.maxUses !== undefined && patch.maxUses !== null && (!Number.isInteger(patch.maxUses) || patch.maxUses < 1)) throw new AppError("COUPON_INVALID", 422, "max uses must be a positive integer");
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.coupon.findFirst({ where: scope, include: withCount });
      if (!before) throw notFound();
      await tx.coupon.update({
        where: { id: before.id },
        data: { ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }), ...(patch.maxUses === undefined ? {} : { maxUses: patch.maxUses }), ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }) },
      });
      const after = await tx.coupon.findUniqueOrThrow({ where: { id: before.id }, include: withCount });
      await this.audit.record(tx, { actorId, action: "coupon.update", targetType: "coupon", targetId: before.id, before: toView(before), after: toView(after), ...meta });
      return toView(after);
    });
  }

  private async remove(scope: Prisma.CouponWhereInput & { id: string }, actorId: string, meta: MutationMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The coupon row lock keeps a checkout from reserving it while it is being deleted.
      await tx.$queryRaw`SELECT "id" FROM "coupons" WHERE "id" = ${scope.id} FOR UPDATE`;
      const before = await tx.coupon.findFirst({ where: scope, include: withCount });
      if (!before) throw notFound();
      if ((await tx.couponRedemption.count({ where: { couponId: before.id } })) > 0 || (await tx.order.count({ where: { couponId: before.id } })) > 0) {
        throw new AppError("COUPON_IN_USE", 409, "This coupon has been used; switch it off with isActive=false instead");
      }
      await tx.coupon.delete({ where: { id: before.id } });
      await this.audit.record(tx, { actorId, action: "coupon.delete", targetType: "coupon", targetId: before.id, before: toView(before), after: null, ...meta });
    });
  }
}
