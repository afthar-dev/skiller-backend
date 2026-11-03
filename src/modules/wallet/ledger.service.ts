import { Injectable } from "@nestjs/common";
import { LedgerAccountKind, LedgerOwnerType, Prisma } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";

export interface LedgerLineInput {
  accountId: string;
  /** Signed paise: positive credits the account, negative debits it. */
  amountPaise: bigint;
}

export interface LedgerEntryInput {
  refType: string;
  refId: string;
  description: string;
  lines: LedgerLineInput[];
}

export interface PostResult {
  entryId: string;
  /** True when (refType, refId, description) was already posted: nothing was written. */
  duplicate: boolean;
}

/**
 * The ONLY write path for journal entries, ledger lines and account balances.
 *
 * Concurrency: the entry row is inserted first with ON CONFLICT DO NOTHING on the unique (refType, refId, description), so a
 * concurrent post of the same key waits for the first one's transaction and then reports a duplicate without raising (a raised
 * unique violation would poison the caller's transaction). Balance rows are then locked FOR UPDATE ordered by account id, so
 * transactions touching overlapping accounts queue instead of deadlocking.
 * Requires READ COMMITTED (the default): the duplicate re-read must see the winner's committed row.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(tx: Prisma.TransactionClient, entry: LedgerEntryInput): Promise<PostResult> {
    const { refType, refId, description, lines } = entry;
    if (!refType || !refId || !description) throw new AppError("LEDGER_INVALID_REF", 500, "Ledger entries need refType, refId and description");
    if (lines.length === 0) throw new AppError("LEDGER_EMPTY", 500, "A ledger entry needs at least one line");
    if (lines.some((l) => typeof l.amountPaise !== "bigint")) throw new AppError("LEDGER_INVALID_LINE", 500, "Ledger line amounts must be bigint paise");
    const sum = lines.reduce((s, l) => s + l.amountPaise, 0n);
    if (sum !== 0n) throw new AppError("LEDGER_UNBALANCED", 500, `Ledger entry does not sum to zero (off by ${sum} paise)`, { refType, refId, description });

    const accountIds = [...new Set(lines.map((l) => l.accountId))].sort();
    const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true } });
    if (accounts.length !== accountIds.length) {
      const known = new Set(accounts.map((a) => a.id));
      throw new AppError("LEDGER_ACCOUNT_NOT_FOUND", 500, "Ledger entry references an unknown account", { accountIds: accountIds.filter((id) => !known.has(id)) });
    }

    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO journal_entries ("id", "refType", "refId", "description")
      VALUES (${uuidv7()}, ${refType}, ${refId}, ${description})
      ON CONFLICT ("refType", "refId", "description") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) {
      const existing = await tx.journalEntry.findUniqueOrThrow({ where: { refType_refId_description: { refType, refId, description } }, select: { id: true } });
      // Same key must mean the same movement: a different set of lines is a caller bug that would otherwise silently drop money.
      const stored = await tx.ledgerLine.findMany({ where: { entryId: existing.id }, select: { accountId: true, amountPaise: true } });
      const canon = (ls: LedgerLineInput[]) => ls.map((x) => `${x.accountId}:${x.amountPaise}`).sort().join("|");
      if (canon(stored) !== canon(lines)) {
        throw new AppError("LEDGER_DUPLICATE_MISMATCH", 409, "Ledger entry key was already posted with different lines", { refType, refId, description });
      }
      return { entryId: existing.id, duplicate: true };
    }
    const entryId = inserted[0].id;

    // Backstop for accounts created without a balance row; one statement over sorted ids, so concurrent inserts cannot deadlock.
    await tx.$executeRaw`INSERT INTO account_balances ("accountId", "balancePaise", "updatedAt")
      SELECT id, 0, ${new Date()} FROM unnest(${accountIds}::text[]) AS t(id) ORDER BY id
      ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT "accountId" FROM account_balances WHERE "accountId" = ANY(${accountIds}::text[]) ORDER BY "accountId" FOR UPDATE`;
    // Checked under the balance locks, so an account close that locks the balance row first cannot interleave. The entry
    // row inserted above is rolled back with the caller's transaction when this throws.
    const closed = await tx.ledgerAccount.findMany({ where: { id: { in: accountIds }, closedAt: { not: null } }, select: { id: true } });
    if (closed.length > 0) throw new AppError("LEDGER_ACCOUNT_CLOSED", 409, "Ledger entry references a closed account", { accountIds: closed.map((a) => a.id) });

    await tx.ledgerLine.createMany({ data: lines.map((l) => ({ entryId, accountId: l.accountId, amountPaise: l.amountPaise })) });

    const deltas = new Map<string, bigint>();
    for (const l of lines) deltas.set(l.accountId, (deltas.get(l.accountId) ?? 0n) + l.amountPaise);
    for (const accountId of accountIds) {
      await tx.accountBalance.update({ where: { accountId }, data: { balancePaise: { increment: deltas.get(accountId)! } } });
    }
    return { entryId, duplicate: false };
  }

  async balance(accountId: string, tx?: Prisma.TransactionClient): Promise<bigint> {
    const row = await (tx ?? this.prisma).accountBalance.findUnique({ where: { accountId }, select: { balancePaise: true } });
    return row?.balancePaise ?? 0n;
  }

  /** Balance per account kind for one owner; kinds the owner has no account for read as 0. Pass null for platform accounts. */
  async balancesFor(ownerType: LedgerOwnerType, ownerId: string | null, tx?: Prisma.TransactionClient): Promise<Record<LedgerAccountKind, bigint>> {
    const result = Object.fromEntries(Object.values(LedgerAccountKind).map((k) => [k, 0n])) as Record<LedgerAccountKind, bigint>;
    const rows = await (tx ?? this.prisma).ledgerAccount.findMany({ where: { ownerType, ownerId }, select: { kind: true, balance: { select: { balancePaise: true } } } });
    for (const r of rows) result[r.kind] = r.balance?.balancePaise ?? 0n;
    return result;
  }
}
