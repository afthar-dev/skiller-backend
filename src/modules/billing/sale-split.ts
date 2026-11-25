import { commissionSplit, gstSplit, type Paise } from "./money";

export type CouponFunding = "CREATOR" | "PLATFORM";

export interface SaleInput {
  listPaise: Paise;
  discountPaise: Paise;
  /** Who pays for the discount; null when there is none. */
  fundedBy: CouponFunding | null;
  commissionBps: number;
  gstBps: number;
}

export interface SaleSplit {
  /** What the buyer pays. */
  totalPaise: Paise;
  /** Credited to the seller's PENDING account. */
  sellerPaise: Paise;
  /** Platform fee excluding GST (PLATFORM_REVENUE) and the GST on it (TAX_PAYABLE). */
  feeNetPaise: Paise;
  feeTaxPaise: Paise;
  /** Debited from PLATFORM_REVENUE when the platform funds the coupon. */
  platformDiscountPaise: Paise;
}

/**
 * How one paid order is divided (plan decisions 1 and 4, spec 12).
 *  - Creator-funded discount: the base for commission is the discounted price, so seller and platform both earn on what was paid.
 *  - Platform-funded discount: the base is the LIST price, so the seller is unaffected and platform revenue absorbs the discount.
 * Cap (MON-1): the seller is never credited more than the buyer actually paid, i.e. sellerPaise = min(normal seller share, totalPaise).
 * A platform-funded coupon is therefore platform-funded only up to the commission. When the cap bites the platform keeps no cash from
 * the sale and the PLATFORM_REVENUE discount line shrinks to (fee + sellerPaise - total), so the entry still sums to zero. Without
 * it a deep launch coupon plus throwaway buyer accounts would pay a creator more than was ever collected.
 * The fee is floored (any remainder stays with the seller); GST is carved out of the fee using the order's snapshotted rate.
 */
export function splitSale(input: SaleInput): SaleSplit {
  const { listPaise, discountPaise, fundedBy, commissionBps, gstBps } = input;
  if (discountPaise < 0n || discountPaise > listPaise) throw new RangeError("discount must be between 0 and the list price");
  const totalPaise = listPaise - discountPaise;
  const platformFunded = fundedBy === "PLATFORM" && discountPaise > 0n;
  const commissionBase = platformFunded ? listPaise : totalPaise;
  const { fee, seller } = commissionSplit(commissionBase, commissionBps);
  const { net, tax } = gstSplit(fee, gstBps);
  const sellerPaise = seller > totalPaise ? totalPaise : seller;
  // Uncapped, fee + seller - total equals the discount; capped it is smaller, which keeps the entry balanced.
  const platformDiscountPaise = platformFunded ? fee + sellerPaise - totalPaise : 0n;
  return { totalPaise, sellerPaise, feeNetPaise: net, feeTaxPaise: tax, platformDiscountPaise };
}

export type SaleLineKind = "clearing" | "seller" | "revenue" | "tax";

/**
 * The signed ledger lines of a sale. A platform-funded discount is its own PLATFORM_REVENUE line (negative), so the entry
 * shows the discount separately from the fee; the net effect on platform revenue is fee - discount.
 */
export function saleLines(s: SaleSplit): { kind: SaleLineKind; amountPaise: Paise }[] {
  const lines: { kind: SaleLineKind; amountPaise: Paise }[] = [
    { kind: "clearing", amountPaise: -s.totalPaise },
    { kind: "seller", amountPaise: s.sellerPaise },
    { kind: "revenue", amountPaise: s.feeNetPaise },
    { kind: "tax", amountPaise: s.feeTaxPaise },
  ];
  if (s.platformDiscountPaise > 0n) lines.push({ kind: "revenue", amountPaise: -s.platformDiscountPaise });
  return lines;
}
