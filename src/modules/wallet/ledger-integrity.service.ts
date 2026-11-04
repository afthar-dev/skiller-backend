import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

export interface BalanceDrift {
  accountId: string;
  kind: string;
  ownerType: string;
  ownerId: string | null;
  /** What account_balances says. */
  storedPaise: bigint;
  /** What the account's lines add up to. */
  linesPaise: bigint;
}

export interface UnbalancedEntry {
  entryId: string;
  refType: string;
  refId: string;
  description: string;
  sumPaise: bigint;
}

/**
 * Read-only ledger invariants, all computed by the database with aggregates (no row loops):
 *  1. every line in the ledger adds up to zero,
 *  2. every account_balances row equals the sum of its account's lines (one statement, so one snapshot),
 *  3. every entry created in a window adds up to zero on its own.
 */
@Injectable()
export class LedgerIntegrity {
  constructor(private readonly prisma: PrismaService) {}

  async totalPaise(): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<{ total: bigint | null }[]>`SELECT COALESCE(SUM("amountPaise"), 0)::bigint AS total FROM "ledger_lines"`;
    return rows[0]?.total ?? 0n;
  }

  /** Accounts whose stored balance differs from the sum of their lines (including accounts with lines but no balance row). */
  async balanceDrift(limit = 200): Promise<BalanceDrift[]> {
    const rows = await this.prisma.$queryRaw<{ accountId: string; kind: string; ownerType: string; ownerId: string | null; stored: bigint | null; lines: bigint | null }[]>`
      SELECT a."id" AS "accountId", a."kind"::text AS "kind", a."ownerType"::text AS "ownerType", a."ownerId" AS "ownerId", b."balancePaise" AS stored, s.total AS lines
      FROM "ledger_accounts" a
      LEFT JOIN "account_balances" b ON b."accountId" = a."id"
      LEFT JOIN (SELECT "accountId", SUM("amountPaise")::bigint AS total FROM "ledger_lines" GROUP BY "accountId") s ON s."accountId" = a."id"
      WHERE COALESCE(b."balancePaise", 0) <> COALESCE(s.total, 0)
      ORDER BY a."id"
      LIMIT ${limit}`;
    return rows.map((r) => ({ accountId: r.accountId, kind: r.kind, ownerType: r.ownerType, ownerId: r.ownerId, storedPaise: r.stored ?? 0n, linesPaise: r.lines ?? 0n }));
  }

  /** Entries created in [from, to) whose own lines do not add up to zero. */
  async unbalancedEntries(from: Date, to: Date, limit = 200): Promise<UnbalancedEntry[]> {
    const rows = await this.prisma.$queryRaw<{ entryId: string; refType: string; refId: string; description: string; sum: bigint }[]>`
      SELECT j."id" AS "entryId", j."refType", j."refId", j."description", SUM(l."amountPaise")::bigint AS sum
      FROM "journal_entries" j JOIN "ledger_lines" l ON l."entryId" = j."id"
      WHERE j."createdAt" >= ${from} AND j."createdAt" < ${to}
      GROUP BY j."id" HAVING SUM(l."amountPaise") <> 0
      ORDER BY j."id" LIMIT ${limit}`;
    return rows.map((r) => ({ entryId: r.entryId, refType: r.refType, refId: r.refId, description: r.description, sumPaise: r.sum }));
  }
}
