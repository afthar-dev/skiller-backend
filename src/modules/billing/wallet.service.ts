import { Injectable } from "@nestjs/common";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SettingsService } from "../admin";
import { LedgerService } from "../wallet";
import type { Owner } from "./entitlements.service";
import { toApi } from "./money";

export interface WalletView {
  currency: "INR";
  /** Paise as decimal strings. AVAILABLE can be negative after a refund of money that was already released. */
  balances: { available: string; pending: string; payoutLocked: string };
  /** Seller share of every sale, less refunds. */
  lifetimeEarnedPaise: string;
  /** Paid out (status PAID), before tax withheld. */
  lifetimeWithdrawnPaise: string;
  minPayoutPaise: string;
  tdsBps: number;
}

export interface LedgerLineView {
  id: string;
  kind: "AVAILABLE" | "PENDING" | "PAYOUT_LOCKED";
  amountPaise: string;
  refType: string;
  refId: string;
  description: string;
  createdAt: string;
}

const SELLER_KINDS = ["AVAILABLE", "PENDING", "PAYOUT_LOCKED"] as const;

/** The seller's read-only view of the ledger: balances, lifetime totals and their own lines. */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
  ) {}

  async me(owner: Owner): Promise<WalletView> {
    const balances = await this.ledger.balancesFor(owner.ownerType, owner.ownerId);
    // Earned = what sales credited to the seller (PENDING) less what refunds took back (from PENDING, or from AVAILABLE once released).
    const earned = await this.prisma.$queryRaw<{ total: bigint }[]>`SELECT COALESCE(SUM(l."amountPaise"), 0)::bigint AS total
      FROM ledger_lines l
      JOIN ledger_accounts a ON a."id" = l."accountId"
      JOIN journal_entries e ON e."id" = l."entryId"
      WHERE a."ownerType" = ${owner.ownerType}::"LedgerOwnerType" AND a."ownerId" = ${owner.ownerId}
        AND a."kind" IN ('PENDING', 'AVAILABLE') AND e."refType" = 'ORDER' AND e."description" IN ('sale', 'refund')`;
    const withdrawn = await this.prisma.payout.aggregate({ where: { ownerType: owner.ownerType, ownerId: owner.ownerId, status: "PAID" }, _sum: { amountPaise: true } });
    return {
      currency: "INR",
      balances: { available: toApi(balances.AVAILABLE), pending: toApi(balances.PENDING), payoutLocked: toApi(balances.PAYOUT_LOCKED) },
      lifetimeEarnedPaise: toApi(earned[0]?.total ?? 0n),
      lifetimeWithdrawnPaise: toApi(withdrawn._sum.amountPaise ?? 0n),
      minPayoutPaise: toApi(BigInt(await this.settings.get("min_payout_paise"))),
      tdsBps: await this.settings.get("tds_bps"),
    };
  }

  /** The owner's own ledger lines (their AVAILABLE / PENDING / PAYOUT_LOCKED accounts), newest first. */
  async ledgerLines(owner: Owner, page: PageQuery) {
    const rows = await this.prisma.ledgerLine.findMany({
      where: { account: { ownerType: owner.ownerType, ownerId: owner.ownerId, kind: { in: [...SELLER_KINDS] } }, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
      include: { account: { select: { kind: true } }, entry: { select: { refType: true, refId: true, description: true, createdAt: true } } },
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return {
      items: items.map(
        (l): LedgerLineView => ({
          id: l.id,
          kind: l.account.kind as LedgerLineView["kind"],
          amountPaise: toApi(l.amountPaise),
          refType: l.entry.refType,
          refId: l.entry.refId,
          description: l.entry.description,
          createdAt: l.entry.createdAt.toISOString(),
        }),
      ),
      nextCursor,
    };
  }
}
