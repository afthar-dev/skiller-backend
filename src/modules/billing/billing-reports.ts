import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ORDER_LEDGER_REF, SALE_DESCRIPTION } from "./fulfilment.service";
import type { Paise } from "./money";
import { REFUND_DESCRIPTION } from "./refunds.service";

export interface SellerRevenue {
  /** Seller share credited by sales posted in the range. */
  soldPaise: Paise;
  /** Seller share taken back by refund reversals posted in the range (a positive number). */
  refundedPaise: Paise;
  /** soldPaise - refundedPaise. */
  netPaise: Paise;
}

/** Read-only reports over billing's own tables, for modules that sell through checkout (they must not read orders or the ledger). */
@Injectable()
export class BillingReports {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the seller actually earned from one item, read from the ledger: the seller's line (PENDING, or AVAILABLE when a refund
   * reversed a share that was already released) of the "sale" and "refund" entries of orders containing the item, for entries
   * posted in [from, to). Coupons, commission and GST are already reflected because the posted amount is what is counted.
   * Checkout sells one item per order; with several items an order's whole share would be attributed to each of them.
   */
  async sellerRevenueForItem(itemType: string, itemId: string, from: Date, to: Date): Promise<SellerRevenue> {
    const rows = await this.prisma.$queryRaw<{ sold: bigint | null; refunded: bigint | null }[]>`
      SELECT
        COALESCE(SUM(l."amountPaise") FILTER (WHERE j."description" = ${SALE_DESCRIPTION}), 0)::bigint AS sold,
        COALESCE(SUM(-l."amountPaise") FILTER (WHERE j."description" = ${REFUND_DESCRIPTION}), 0)::bigint AS refunded
      FROM "journal_entries" j
      JOIN "ledger_lines" l ON l."entryId" = j."id"
      JOIN "ledger_accounts" a ON a."id" = l."accountId"
      JOIN "orders" o ON o."id" = j."refId"
      WHERE j."refType" = ${ORDER_LEDGER_REF}
        AND j."description" IN (${SALE_DESCRIPTION}, ${REFUND_DESCRIPTION})
        AND j."createdAt" >= ${from} AND j."createdAt" < ${to}
        AND a."kind" IN ('PENDING', 'AVAILABLE')
        AND a."ownerType"::text = o."sellerOwnerType"::text
        AND a."ownerId" = o."sellerOwnerId"
        AND EXISTS (SELECT 1 FROM "order_items" oi WHERE oi."orderId" = o."id" AND oi."itemType" = ${itemType} AND oi."itemId" = ${itemId})
    `;
    const soldPaise = rows[0]?.sold ?? 0n;
    const refundedPaise = rows[0]?.refunded ?? 0n;
    return { soldPaise, refundedPaise, netPaise: soldPaise - refundedPaise };
  }
}
