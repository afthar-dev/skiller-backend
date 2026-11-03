import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Coupon, type CouponFunding, type CouponKind, type CouponScope, type SellerOwnerType } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EntitlementsService } from "./entitlements.service";
import { splitBps, type Paise } from "./money";

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export const normalizeCouponCode = (code: string): string => code.trim().toUpperCase();

export interface CreateCouponInput {
  code: string;
  kind: CouponKind;
  /** PERCENT: basis points (2000 = 20%). FLAT: paise. */
  value: bigint;
  fundedBy: CouponFunding;
  /** The seller the coupon belongs to (required for CREATOR) or targets (PLATFORM with scope SELLER). */
  ownerType?: SellerOwnerType;
  ownerId?: string;
  scope?: CouponScope;
  itemType?: string;
  itemId?: string;
  maxUses?: number;
  expiresAt?: Date;
  createdBy?: string;
}

export interface CouponCheck {
  buyerId: string;
  code: string;
  item: { type: string; id: string; sellerOwnerType: SellerOwnerType; sellerOwnerId: string };
  listPaise: Paise;
}

const invalid = (message: string) => new AppError("COUPON_INVALID", 422, message);

@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(input: CreateCouponInput): Promise<Coupon> {
    const code = normalizeCouponCode(input.code);
    const scope = input.scope ?? "ALL";
    if (!CODE_PATTERN.test(code)) throw invalid("Coupon codes are 3-32 characters: letters, digits, dash and underscore");
    if (input.kind === "PERCENT" ? input.value < 1n || input.value > 10_000n : input.value < 1n) {
      throw invalid(input.kind === "PERCENT" ? "A percentage is 1 to 10000 basis points" : "A flat discount must be at least 1 paisa");
    }
    if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) throw invalid("max uses must be a positive integer");
    if ((input.ownerType === undefined) !== (input.ownerId === undefined)) throw invalid("ownerType and ownerId go together");
    if (scope === "ITEM" && (!input.itemType || !input.itemId)) throw invalid("An item coupon needs itemType and itemId");
    if (scope !== "ITEM" && (input.itemType || input.itemId)) throw invalid("itemType and itemId only apply to item coupons");
    if (scope === "SELLER" && !input.ownerId) throw invalid("A seller coupon needs the seller");
    if (scope === "ALL" && input.ownerId) throw invalid("A coupon for everything cannot belong to a seller");

    if (input.fundedBy === "CREATOR") {
      if (!input.ownerType || !input.ownerId) throw invalid("A creator-funded coupon needs its owner");
      if (scope === "ALL") throw invalid("A creator-funded coupon must be limited to the creator's own items");
      await this.entitlements.check({ ownerType: input.ownerType, ownerId: input.ownerId }, "creator_coupons", 0);
    }

    try {
      return await this.prisma.coupon.create({
        data: {
          code,
          kind: input.kind,
          value: input.value,
          fundedBy: input.fundedBy,
          ownerType: input.ownerType ?? null,
          ownerId: input.ownerId ?? null,
          scope,
          itemType: input.itemType ?? null,
          itemId: input.itemId ?? null,
          maxUses: input.maxUses ?? null,
          expiresAt: input.expiresAt ?? null,
          createdBy: input.createdBy ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new AppError("COUPON_CODE_TAKEN", 409, "That coupon code already exists");
      throw err;
    }
  }

  /**
   * Whether the buyer may use the coupon on this item now, and the discount it gives. Read-only: the redemption is counted when the
   * order is paid, so this check only prevents most over-use (FulfilmentService is the authority).
   */
  async evaluate(check: CouponCheck): Promise<{ coupon: Coupon; discountPaise: Paise }> {
    const coupon = await this.prisma.coupon.findUnique({ where: { code: normalizeCouponCode(check.code) } });
    if (!coupon) throw new AppError("COUPON_NOT_FOUND", 404, "Coupon not found");
    if (!coupon.isActive) throw new AppError("COUPON_INACTIVE", 422, "This coupon is no longer active");
    if (coupon.expiresAt && coupon.expiresAt.getTime() <= this.clock.now().getTime()) throw new AppError("COUPON_EXPIRED", 422, "This coupon has expired");

    const { item } = check;
    const ownedBySeller = coupon.ownerType === item.sellerOwnerType && coupon.ownerId === item.sellerOwnerId;
    const notApplicable = () => new AppError("COUPON_NOT_APPLICABLE", 422, "This coupon does not apply to this item");
    if (coupon.scope === "SELLER" && !ownedBySeller) throw notApplicable();
    if (coupon.scope === "ITEM" && (coupon.itemType !== item.type || coupon.itemId !== item.id)) throw notApplicable();
    if (coupon.fundedBy === "CREATOR") {
      // A creator can only discount their own items, and only while their plan still includes creator coupons.
      if (!ownedBySeller) throw notApplicable();
      if ((await this.entitlements.limit({ ownerType: item.sellerOwnerType, ownerId: item.sellerOwnerId }, "creator_coupons")) !== true) throw notApplicable();
    }

    if (coupon.maxUses !== null && (await this.prisma.couponRedemption.count({ where: { couponId: coupon.id } })) >= coupon.maxUses) {
      throw new AppError("COUPON_EXHAUSTED", 422, "This coupon has been used up");
    }
    if (await this.prisma.couponRedemption.findUnique({ where: { couponId_userId: { couponId: coupon.id, userId: check.buyerId } }, select: { id: true } })) {
      throw new AppError("COUPON_ALREADY_USED", 409, "You have already used this coupon");
    }

    const raw = coupon.kind === "PERCENT" ? splitBps(check.listPaise, Number(coupon.value)).part : coupon.value;
    return { coupon, discountPaise: raw > check.listPaise ? check.listPaise : raw };
  }
}
