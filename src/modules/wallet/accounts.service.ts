import { Injectable } from "@nestjs/common";
import type { LedgerAccountKind, Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ensureAccount, PLATFORM_KINDS, SELLER_KINDS, type PlatformKind, type SellerKind } from "./ledger-sql";

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates AVAILABLE, PENDING and PAYOUT_LOCKED for a seller (user or organization) with zero balances. Idempotent and
   * safe under concurrency: kinds are always created in the same order and inserts never fail on conflict.
   */
  async ensureSellerAccounts(tx: Prisma.TransactionClient, ownerType: "USER" | "ORG", ownerId: string): Promise<Record<SellerKind, string>> {
    const ids = {} as Record<SellerKind, string>;
    for (const kind of SELLER_KINDS) ids[kind] = await ensureAccount(tx, ownerType, ownerId, kind);
    return ids;
  }

  /** Account id of a platform-owned account. Seeded, and created on first use if the seed has not run. */
  async platformAccount(kind: PlatformKind, tx?: Prisma.TransactionClient): Promise<string> {
    if (!(PLATFORM_KINDS as readonly LedgerAccountKind[]).includes(kind)) throw new Error(`${kind} is not a platform account kind`);
    return ensureAccount(tx ?? this.prisma, "PLATFORM", null, kind);
  }
}
