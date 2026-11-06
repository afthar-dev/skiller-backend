import { Injectable } from "@nestjs/common";
import { istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ORDER_LEDGER_REF } from "./fulfilment.service";
import { REFUND_DESCRIPTION } from "./refunds.service";

/** An order counts as a sale on the IST day it was paid, whatever happened to it afterwards (a refund is its own number, on the day it was posted). */
const SOLD = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] as const;

/**
 * Daily rollup numbers owned by billing, all in integer paise: orders, GMV, platform revenue (net movement of the PLATFORM_REVENUE ledger account),
 * refunds (the ledger's refund entries), payouts paid, sellers making their first sale, and the number of active paid subscribers (a level: the
 * value when the rollup ran).
 */
@Injectable()
export class BillingMetricsProvider implements MetricsProvider {
  readonly module = "billing";

  constructor(private readonly prisma: PrismaService) {}

  async collect(day: string): Promise<MetricPoint[]> {
    const { from, to } = istDayRange(day);
    const [sales, revenue, refunds, payouts, firstSales, subscribers] = await Promise.all([
      this.prisma.order.aggregate({ where: { status: { in: [...SOLD] }, paidAt: { gte: from, lt: to } }, _sum: { totalPaise: true }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(l."amountPaise"), 0)::bigint AS total
        FROM "ledger_lines" l
        JOIN "journal_entries" j ON j."id" = l."entryId"
        JOIN "ledger_accounts" a ON a."id" = l."accountId"
        WHERE a."ownerType" = 'PLATFORM' AND a."kind" = 'PLATFORM_REVENUE' AND j."createdAt" >= ${from} AND j."createdAt" < ${to}`,
      this.prisma.$queryRaw<{ total: bigint; entries: bigint }[]>`
        SELECT COALESCE(SUM(l."amountPaise"), 0)::bigint AS total, COUNT(DISTINCT j."id") AS entries
        FROM "ledger_lines" l
        JOIN "journal_entries" j ON j."id" = l."entryId"
        JOIN "ledger_accounts" a ON a."id" = l."accountId" AND a."kind" = 'GATEWAY_CLEARING'
        WHERE j."refType" = ${ORDER_LEDGER_REF} AND j."description" = ${REFUND_DESCRIPTION} AND j."createdAt" >= ${from} AND j."createdAt" < ${to}`,
      this.prisma.payout.aggregate({ where: { status: "PAID", paidAt: { gte: from, lt: to } }, _sum: { amountPaise: true } }),
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT o."sellerOwnerType"::text || ':' || o."sellerOwnerId")::bigint AS n
        FROM "orders" o
        WHERE o."status" IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') AND o."paidAt" >= ${from} AND o."paidAt" < ${to}
          AND NOT EXISTS (
            SELECT 1 FROM "orders" e
            WHERE e."sellerOwnerType" = o."sellerOwnerType" AND e."sellerOwnerId" = o."sellerOwnerId"
              AND e."status" IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') AND e."paidAt" < ${from})`,
      this.prisma.subscription.count({ where: { status: "ACTIVE", planVersion: { pricePaise: { gt: 0 } } } }),
    ]);
    return [
      { key: "orders_paid", value: BigInt(sales._count._all) },
      { key: "gmv_paise", value: sales._sum.totalPaise ?? 0n },
      { key: "platform_revenue_paise", value: revenue[0]?.total ?? 0n },
      { key: "refunds_paise", value: refunds[0]?.total ?? 0n },
      { key: "refunds_count", value: refunds[0]?.entries ?? 0n },
      { key: "payouts_paid_paise", value: payouts._sum.amountPaise ?? 0n },
      { key: "sellers_first_sale", value: firstSales[0]?.n ?? 0n },
      { key: "active_paid_subscribers", value: BigInt(subscribers) },
    ];
  }
}
