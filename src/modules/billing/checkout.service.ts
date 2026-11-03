import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Coupon } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SettingsService } from "../admin";
import { RolesService } from "../rbac";
import { CouponsService } from "./coupons.service";
import { EntitlementsService } from "./entitlements.service";
import { toApi, type Paise } from "./money";
import { FREE_FALLBACK } from "./plan-catalog";
import { RAZORPAY_CLIENT, type RazorpayClient } from "./razorpay.client";
import { splitSale } from "./sale-split";
import { SellableRegistry } from "./sellable.registry";

/** Razorpay does not accept orders below 1 INR. */
export const MIN_CHARGE_PAISE: Paise = 100n;

export interface CheckoutRequest {
  itemType: string;
  itemId: string;
  couponCode?: string;
}

export interface CheckoutResult {
  orderId: string;
  razorpayOrderId: string;
  /** Paise as a decimal string. */
  amountPaise: string;
  currency: string;
  keyId: string;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SellableRegistry,
    private readonly coupons: CouponsService,
    private readonly entitlements: EntitlementsService,
    private readonly roles: RolesService,
    private readonly settings: SettingsService,
    @Inject(RAZORPAY_CLIENT) private readonly razorpay: RazorpayClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Everything that decides the money is computed here from server state: the price from the provider, the discount from the
   * coupon, the commission from the seller's plan at this moment, GST from settings. Nothing the client sends influences it.
   */
  async create(buyerId: string, req: CheckoutRequest): Promise<CheckoutResult> {
    const provider = this.registry.find(req.itemType);
    if (!provider) throw new AppError("UNKNOWN_ITEM_TYPE", 400, `Unknown item type ${req.itemType}`);

    const item = await provider.describe(req.itemId, { buyerId });
    // Your own item, or one sold by an organization you hold any role in (a wash sale that would dodge the platform fee).
    const own = item.sellerOwnerType === "USER" ? item.sellerOwnerId === buyerId : await this.roles.isOrgMember(item.sellerOwnerId, buyerId);
    if (own) throw new AppError("CHECKOUT_SELF_PURCHASE", 422, "You cannot buy your own item");
    if (!item.purchasable) throw new AppError("ITEM_NOT_PURCHASABLE", 409, item.reason ?? "This item cannot be purchased", item.reason ? { reason: item.reason } : {});
    if (item.pricePaise < MIN_CHARGE_PAISE) throw new AppError("CHECKOUT_PRICE_TOO_LOW", 422, "This item has no payable price");

    const plan = await this.entitlements.planFor(item.sellerOwnerType, item.sellerOwnerId);
    if (plan.versionId === FREE_FALLBACK.versionId) {
      // The catalog has no Free plan row (unseeded database): there is no plan version to snapshot on the order.
      throw new AppError("CHECKOUT_UNAVAILABLE", 503, "Plans are not set up yet");
    }
    const gstBps = await this.settings.get("gst_bps");

    // With a coupon, the use is checked and reserved under a lock on the coupon row, in the same transaction that creates the
    // order: parallel checkouts (same buyer, or many buyers on the last use) queue on the lock and see each other's reservations.
    const order = await this.prisma.$transaction(
      async (tx) => {
        let discountPaise: Paise = 0n;
        let coupon: Coupon | null = null;
        if (req.couponCode) {
          await this.coupons.lockByCode(tx, req.couponCode);
          const evaluated = await this.coupons.evaluate(
            {
              buyerId,
              code: req.couponCode,
              item: { type: req.itemType, id: req.itemId, sellerOwnerType: item.sellerOwnerType, sellerOwnerId: item.sellerOwnerId },
              listPaise: item.pricePaise,
            },
            tx,
          );
          coupon = evaluated.coupon;
          discountPaise = evaluated.discountPaise;
        }
        const totalPaise = item.pricePaise - discountPaise;
        if (totalPaise < MIN_CHARGE_PAISE) throw new AppError("CHECKOUT_TOTAL_TOO_LOW", 422, "This coupon leaves less than 1 INR to pay");
        // Validates the snapshot (a bad rate throws here, before an order exists).
        splitSale({ listPaise: item.pricePaise, discountPaise, fundedBy: coupon?.fundedBy ?? null, commissionBps: plan.commissionBps, gstBps });

        const created = await tx.order.create({
          data: {
            buyerId,
            listPricePaise: item.pricePaise,
            discountPaise,
            totalPaise,
            couponId: coupon?.id ?? null,
            couponFundedBy: coupon && discountPaise > 0n ? coupon.fundedBy : null,
            sellerOwnerType: item.sellerOwnerType,
            sellerOwnerId: item.sellerOwnerId,
            commissionBps: plan.commissionBps,
            gstBps,
            planVersionId: plan.versionId,
            createdAt: this.clock.now(),
            items: { create: [{ itemType: req.itemType, itemId: req.itemId, title: item.title, unitPricePaise: item.pricePaise }] },
          },
        });
        if (coupon) await this.coupons.reserve(tx, coupon.id, buyerId, created.id);
        return created;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    const totalPaise = order.totalPaise;

    let razorpayOrderId: string;
    try {
      razorpayOrderId = (await this.razorpay.createOrder({ amountPaise: totalPaise, receipt: order.id, notes: { orderId: order.id } })).id;
      await this.prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId } });
    } catch (err) {
      await this.prisma.$transaction(async (tx) => {
        const failed = await tx.order.updateMany({ where: { id: order.id, status: "CREATED" }, data: { status: "FAILED" } });
        if (failed.count === 1) await this.coupons.release(tx, [order.id]);
      });
      this.logger.error(`could not create the Razorpay order for ${order.id}: ${(err as Error).message}`);
      throw new AppError("PAYMENT_GATEWAY_ERROR", 502, "The payment gateway is unavailable; try again");
    }

    return { orderId: order.id, razorpayOrderId, amountPaise: toApi(totalPaise), currency: order.currency, keyId: this.config.razorpay.keyId };
  }
}
