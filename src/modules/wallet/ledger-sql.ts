import type { LedgerAccountKind, LedgerOwnerType, Prisma } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";

/** Both PrismaClient and a transaction client satisfy this, so the seed script and services share one implementation. */
export type LedgerDb = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw" | "ledgerAccount">;

export const SELLER_KINDS = ["AVAILABLE", "PENDING", "PAYOUT_LOCKED"] as const satisfies readonly LedgerAccountKind[];
export const PLATFORM_KINDS = ["GATEWAY_CLEARING", "PLATFORM_REVENUE", "TAX_PAYABLE", "REFUNDS"] as const satisfies readonly LedgerAccountKind[];
export type SellerKind = (typeof SELLER_KINDS)[number];
export type PlatformKind = (typeof PLATFORM_KINDS)[number];

/**
 * Creates the account and its zero balance row unless they exist (race-safe: ON CONFLICT DO NOTHING on the
 * NULLS NOT DISTINCT unique index, so a null owner id still conflicts). Returns the account id.
 */
export async function ensureAccount(db: LedgerDb, ownerType: LedgerOwnerType, ownerId: string | null, kind: LedgerAccountKind): Promise<string> {
  await db.$executeRaw`INSERT INTO ledger_accounts ("id", "ownerType", "ownerId", "kind", "currency")
    VALUES (${uuidv7()}, ${ownerType}::"LedgerOwnerType", ${ownerId}, ${kind}::"LedgerAccountKind", 'INR')
    ON CONFLICT DO NOTHING`;
  const account = await db.ledgerAccount.findFirstOrThrow({ where: { ownerType, ownerId, kind }, select: { id: true } });
  await db.$executeRaw`INSERT INTO account_balances ("accountId", "balancePaise", "updatedAt") VALUES (${account.id}, 0, ${new Date()}) ON CONFLICT DO NOTHING`;
  return account.id;
}

/** Idempotent: used by the seed script and (lazily) by AccountsService.platformAccount. */
export async function ensurePlatformAccounts(db: LedgerDb): Promise<Record<PlatformKind, string>> {
  const ids = {} as Record<PlatformKind, string>;
  for (const kind of PLATFORM_KINDS) ids[kind] = await ensureAccount(db, "PLATFORM", null, kind);
  return ids;
}
