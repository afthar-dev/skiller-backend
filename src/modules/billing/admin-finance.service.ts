import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, SubscriptionOwnerType, SubscriptionStatus } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { addDays, istDateOf, istDayRange } from "./ist";
import { ORDER_LEDGER_REF } from "./fulfilment.service";
import { toApi } from "./money";
import { REFUND_DESCRIPTION } from "./refunds.service";

export interface FinanceSummary {
  from: string;
  to: string;
  currency: "INR";
  /** Sum of the totals buyers paid for orders that are PAID and were paid inside the window (a refunded order leaves GMV). */
  gmvPaise: string;
  orderCount: number;
  /** Net movement of the PLATFORM_REVENUE account in the window (fees, less platform-funded discounts, less refunds). */
  platformRevenuePaise: string;
  /** Net movement of the TAX_PAYABLE account in the window (GST on fees, plus TDS withheld, less reversals). */
  taxPayablePaise: string;
  /** Money returned to buyers: the refund entries posted in the window. */
  refundsProcessedPaise: string;
  refundCount: number;
  /** Payouts that reached PAID in the window (gross, before TDS). */
  payoutsPaidPaise: string;
  payoutsPaidCount: number;
  /** Payouts REQUESTED / APPROVED / PROCESSING right now (not windowed: it is what is waiting). */
  payoutsPendingPaise: string;
  payoutsPendingCount: number;
  /** Subscriptions ACTIVE right now on a plan that costs money. */
  activePaidSubscribers: number;
}

const MAX_SPAN_DAYS = 366;

export interface SubscriptionRow {
  id: string;
  ownerType: SubscriptionOwnerType;
  ownerId: string;
  status: SubscriptionStatus;
  plan: { key: string; name: string; versionId: string; interval: string; pricePaise: string; commissionBps: number };
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: string | null;
  razorpaySubscriptionId: string | null;
  createdAt: string;
}

/** Finance's read side: the summary (every number comes from the ledger or the money tables) and the subscriptions list. */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `from` / `to` are IST calendar days, both inclusive; they default to the last 30 days. */
  async summary(fromDate?: string, toDate?: string): Promise<FinanceSummary> {
    const to = toDate ?? istDateOf(this.clock.now());
    const from = fromDate ?? addDays(to, -29);
    let window: { from: Date; to: Date };
    try {
      window = { from: istDayRange(from).from, to: istDayRange(to).to };
    } catch {
      throw new AppError("FINANCE_RANGE_INVALID", 400, "from and to must be calendar days, YYYY-MM-DD (India time)");
    }
    if (window.from >= window.to) throw new AppError("FINANCE_RANGE_INVALID", 400, "from must not be after to");
    if (window.to.getTime() - window.from.getTime() > MAX_SPAN_DAYS * 86_400_000) throw new AppError("FINANCE_RANGE_INVALID", 400, `The range is limited to ${MAX_SPAN_DAYS} days`);

    const [gmv, movement, refunds, paid, pending, subscribers] = await Promise.all([
      this.prisma.order.aggregate({ where: { status: "PAID", paidAt: { gte: window.from, lt: window.to } }, _sum: { totalPaise: true }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ kind: string; total: bigint }[]>`
        SELECT a."kind"::text AS kind, COALESCE(SUM(l."amountPaise"), 0)::bigint AS total
        FROM "ledger_lines" l
        JOIN "journal_entries" j ON j."id" = l."entryId"
        JOIN "ledger_accounts" a ON a."id" = l."accountId"
        WHERE a."ownerType" = 'PLATFORM' AND a."kind" IN ('PLATFORM_REVENUE', 'TAX_PAYABLE') AND j."createdAt" >= ${window.from} AND j."createdAt" < ${window.to}
        GROUP BY a."kind"`,
      this.prisma.$queryRaw<{ total: bigint; entries: bigint }[]>`
        SELECT COALESCE(SUM(l."amountPaise"), 0)::bigint AS total, COUNT(DISTINCT j."id") AS entries
        FROM "ledger_lines" l
        JOIN "journal_entries" j ON j."id" = l."entryId"
        JOIN "ledger_accounts" a ON a."id" = l."accountId" AND a."kind" = 'GATEWAY_CLEARING'
        WHERE j."refType" = ${ORDER_LEDGER_REF} AND j."description" = ${REFUND_DESCRIPTION} AND j."createdAt" >= ${window.from} AND j."createdAt" < ${window.to}`,
      this.prisma.payout.aggregate({ where: { status: "PAID", paidAt: { gte: window.from, lt: window.to } }, _sum: { amountPaise: true }, _count: { _all: true } }),
      this.prisma.payout.aggregate({ where: { status: { in: ["REQUESTED", "APPROVED", "PROCESSING"] } }, _sum: { amountPaise: true }, _count: { _all: true } }),
      this.prisma.subscription.count({ where: { status: "ACTIVE", planVersion: { pricePaise: { gt: 0 } } } }),
    ]);
    const moved = (kind: string) => movement.find((m) => m.kind === kind)?.total ?? 0n;
    return {
      from,
      to,
      currency: "INR",
      gmvPaise: toApi(gmv._sum.totalPaise ?? 0n),
      orderCount: gmv._count._all,
      platformRevenuePaise: toApi(moved("PLATFORM_REVENUE")),
      taxPayablePaise: toApi(moved("TAX_PAYABLE")),
      refundsProcessedPaise: toApi(refunds[0]?.total ?? 0n),
      refundCount: Number(refunds[0]?.entries ?? 0n),
      payoutsPaidPaise: toApi(paid._sum.amountPaise ?? 0n),
      payoutsPaidCount: paid._count._all,
      payoutsPendingPaise: toApi(pending._sum.amountPaise ?? 0n),
      payoutsPendingCount: pending._count._all,
      activePaidSubscribers: subscribers,
    };
  }

  async listSubscriptions(filter: { status?: SubscriptionStatus; ownerType?: SubscriptionOwnerType; ownerId?: string; planKey?: string; createdAt?: { gte?: Date; lt?: Date } }, page: PageQuery) {
    const where: Prisma.SubscriptionWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ownerType ? { ownerType: filter.ownerType } : {}),
      ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
      ...(filter.planKey ? { planVersion: { plan: { key: filter.planKey } } } : {}),
      ...(filter.createdAt ? { createdAt: filter.createdAt } : {}),
      ...(page.cursor ? { id: { lt: page.cursor } } : {}),
    };
    const rows = await this.prisma.subscription.findMany({ where, orderBy: { id: "desc" }, take: page.limit + 1, include: { planVersion: { include: { plan: true } } } });
    const { items, nextCursor } = toPage(rows, page.limit);
    return {
      items: items.map(
        (s): SubscriptionRow => ({
          id: s.id,
          ownerType: s.ownerType,
          ownerId: s.ownerId,
          status: s.status,
          plan: { key: s.planVersion.plan.key, name: s.planVersion.plan.name, versionId: s.planVersionId, interval: s.planVersion.interval, pricePaise: toApi(s.planVersion.pricePaise), commissionBps: s.planVersion.commissionBps },
          currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
          razorpaySubscriptionId: s.razorpaySubscriptionId,
          createdAt: s.createdAt.toISOString(),
        }),
      ),
      nextCursor,
    };
  }
}
