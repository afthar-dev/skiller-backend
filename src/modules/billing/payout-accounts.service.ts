import { Inject, Injectable, Logger } from "@nestjs/common";
import type { PayoutAccount, Prisma } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import type { MutationMeta } from "../rbac";
import type { Owner } from "./entitlements.service";
import { FinanceAlerts } from "./finance-alerts.service";
import { last4, maskVpa, namesMatch, panHash } from "./kyc";
import { RazorpayApiError } from "./razorpay.client";
import { RAZORPAYX_CLIENT, type RazorpayXClient } from "./razorpayx.client";

/** Payouts to a replacement account are blocked for this long (anti-fraud: a hijacked session cannot add an account and cash out at once). */
export const PAYOUT_ACCOUNT_COOLDOWN = 24 * 60 * 60 * 1000;
export const DUPLICATE_PAN_FLAG = "DUPLICATE_PAN";
export const NAME_MISMATCH_FLAG = "NAME_MISMATCH";

export interface PayoutAccountInput {
  type: "BANK" | "UPI";
  bank?: { ifsc: string; accountNumber: string; holderName: string };
  upi?: { vpa: string };
  /** Upper-case, already shaped like a PAN. */
  pan: string;
  /** Name on the RazorpayX contact: the bank holder name, or the person for a UPI id. */
  contactName: string;
}

/** What the owner sees: masked details only. */
export interface PayoutAccountView {
  id: string;
  type: "BANK" | "UPI";
  status: "PENDING" | "VERIFIED" | "FAILED" | "INACTIVE";
  holderName: string;
  ifsc: string | null;
  accountLast4: string | null;
  vpaMasked: string | null;
  panLast4: string;
  panNameMatch: boolean | null;
  failureReason: string | null;
  verifiedAt: string | null;
  /** Payouts are blocked until this moment. */
  cooldownEndsAt: string;
  createdAt: string;
}

export interface AdminPayoutAccountView extends PayoutAccountView {
  ownerType: "USER" | "ORG";
  ownerId: string;
  reviewFlag: string | null;
}

export const toPayoutAccountView = (a: PayoutAccount): PayoutAccountView => ({
  id: a.id,
  type: a.type,
  status: a.status,
  holderName: a.holderName,
  ifsc: a.ifsc,
  accountLast4: a.accountLast4,
  vpaMasked: a.vpaMasked,
  panLast4: a.panLast4,
  panNameMatch: a.panNameMatch,
  failureReason: a.failureReason,
  verifiedAt: a.verifiedAt?.toISOString() ?? null,
  cooldownEndsAt: a.cooldownUntil.toISOString(),
  createdAt: a.createdAt.toISOString(),
});

const toAdminView = (a: PayoutAccount): AdminPayoutAccountView => ({ ...toPayoutAccountView(a), ownerType: a.ownerType, ownerId: a.ownerId, reviewFlag: a.reviewFlag });

/** What fund_account.validation.* says about a fund account. */
export interface ValidationResult {
  fundAccountId: string;
  /** "completed" or "failed" */
  status: string;
  /** results.account_status of a completed validation ("active" = the account exists and can receive money). */
  accountStatus: string | null;
  registeredName: string | null;
}

const gatewayDown = () => new AppError("PAYOUT_GATEWAY_ERROR", 502, "The payout provider is unavailable; try again in a moment");

/**
 * Payout accounts: where an owner's money goes. Full bank account numbers, UPI ids and PANs exist only in the request to RazorpayX; what is
 * stored is the IFSC, the last four digits, a masked UPI id, the last four of the PAN and a keyed hash of the PAN.
 */
@Injectable()
export class PayoutAccountsService {
  private readonly logger = new Logger(PayoutAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAZORPAYX_CLIENT) private readonly razorpayx: RazorpayXClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly alerts: FinanceAlerts,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sets the owner's payout account. RazorpayX is called first (contact, fund account, validation start), outside any transaction, so a
   * provider outage changes nothing; then one transaction retires the old account, stores the new one (PENDING, cooldown running)
   * and writes the audit row. The validation result arrives later by webhook.
   */
  async put(owner: Owner, actorId: string, input: PayoutAccountInput, meta: MutationMeta = {}): Promise<PayoutAccountView> {
    const id = uuidv7();
    let ids: { contactId: string; fundAccountId: string };
    try {
      const contact = await this.razorpayx.createContact({ name: input.contactName, referenceId: `${owner.ownerType}:${owner.ownerId}` });
      const fund = await this.razorpayx.createFundAccount({
        contactId: contact.id,
        ...(input.type === "BANK" ? { bank: { name: input.bank!.holderName, ifsc: input.bank!.ifsc, accountNumber: input.bank!.accountNumber } } : { vpa: { address: input.upi!.vpa } }),
      });
      await this.razorpayx.validateFundAccount({ fundAccountId: fund.id, referenceId: id });
      ids = { contactId: contact.id, fundAccountId: fund.id };
    } catch (err) {
      if (err instanceof RazorpayApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        // The provider's description may echo what we sent, so it is neither returned nor logged.
        this.logger.warn(`RazorpayX refused the payout account of ${owner.ownerType}:${owner.ownerId} (HTTP ${err.status}${err.code ? ` ${err.code}` : ""})`);
        throw new AppError("PAYOUT_ACCOUNT_REJECTED", 422, "The payout provider did not accept these account details; check them and try again");
      }
      this.logger.error(`RazorpayX unavailable while setting the payout account of ${owner.ownerType}:${owner.ownerId}: ${(err as Error).name}`);
      throw gatewayDown();
    }

    const hash = panHash(this.config.kycPepper, input.pan);
    const now = this.clock.now();
    const { account, previous, duplicateOf } = await this.prisma.$transaction(async (tx) => {
      // Same PAN submitted by two owners at once, and one owner submitting twice, are both serialised here (pan lock first, then owner lock).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-pan:${hash}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-owner:${owner.ownerType}:${owner.ownerId}`}))`;
      const live = await tx.payoutAccount.findFirst({ where: { ownerType: owner.ownerType, ownerId: owner.ownerId, status: { not: "INACTIVE" } } });
      if (live) await tx.payoutAccount.update({ where: { id: live.id }, data: { status: "INACTIVE" } });
      const other = await tx.payoutAccount.findFirst({ where: { panHash: hash, NOT: { ownerType: owner.ownerType, ownerId: owner.ownerId } }, select: { id: true, ownerType: true, ownerId: true } });
      const created = await tx.payoutAccount.create({
        data: {
          id,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          type: input.type,
          holderName: input.type === "BANK" ? input.bank!.holderName : input.contactName,
          ifsc: input.type === "BANK" ? input.bank!.ifsc : null,
          accountLast4: input.type === "BANK" ? last4(input.bank!.accountNumber) : null,
          vpaMasked: input.type === "UPI" ? maskVpa(input.upi!.vpa) : null,
          panLast4: last4(input.pan),
          panHash: hash,
          razorpayxContactId: ids.contactId,
          razorpayxFundAccountId: ids.fundAccountId,
          // Only REPLACING an account starts the pause: a first account has nothing to be hijacked from.
          cooldownUntil: live ? new Date(now.getTime() + PAYOUT_ACCOUNT_COOLDOWN) : now,
          createdBy: actorId,
          ...(other ? { reviewFlag: DUPLICATE_PAN_FLAG } : {}),
        },
      });
      // The older account holding the same PAN is flagged too, so finance sees both sides of the pair.
      if (other) await tx.payoutAccount.updateMany({ where: { panHash: hash, reviewFlag: null, NOT: { ownerType: owner.ownerType, ownerId: owner.ownerId } }, data: { reviewFlag: DUPLICATE_PAN_FLAG } });
      await this.audit.record(tx, {
        actorId,
        action: "payout_account.change",
        targetType: "payout_account",
        targetId: created.id,
        before: live ? toPayoutAccountView(live) : null,
        after: { ...toPayoutAccountView(created), ownerType: owner.ownerType, ownerId: owner.ownerId, reviewFlag: created.reviewFlag },
        ...meta,
      });
      await this.outbox.enqueue(tx, {
        type: "payout_account.changed",
        payoutAccountId: created.id,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        changedBy: actorId,
        cooldownUntil: created.cooldownUntil.toISOString(),
        replaced: !!live,
        accountSummary: created.type === "BANK" ? `bank account ending ${created.accountLast4}` : `UPI id ${created.vpaMasked}`,
      });
      return { account: created, previous: live, duplicateOf: other };
    });

    if (duplicateOf) {
      await this.alerts.raise({
        kind: "DUPLICATE_PAN",
        message: `The same PAN (ending ${account.panLast4}) is on the payout accounts of ${owner.ownerType} ${owner.ownerId} and ${duplicateOf.ownerType} ${duplicateOf.ownerId}. Payouts are not blocked; review whether these are the same person.`,
        dedupeKey: `duplicate-pan:${account.id}`,
        link: "/admin/payout-accounts?flagged=true",
        data: { payoutAccountId: account.id, otherPayoutAccountId: duplicateOf.id },
      });
    }
    this.logger.log(`payout account ${account.id} set for ${owner.ownerType}:${owner.ownerId}${previous ? ` (replaces ${previous.id})` : ""}`);
    return toPayoutAccountView(account);
  }

  /** The owner's live (not replaced) account, masked; null if none. */
  async current(owner: Owner): Promise<PayoutAccountView | null> {
    const a = await this.prisma.payoutAccount.findFirst({ where: { ownerType: owner.ownerType, ownerId: owner.ownerId, status: { not: "INACTIVE" } } });
    return a ? toPayoutAccountView(a) : null;
  }

  /**
   * The account a payout would go to, or the reason none can: no account (PAYOUT_ACCOUNT_REQUIRED), not validated yet or failed
   * (PAYOUT_ACCOUNT_NOT_VERIFIED), or changed less than 24 h ago (PAYOUT_ACCOUNT_COOLDOWN). Time comes from the Clock.
   */
  async payableAccount(owner: Owner, tx?: Prisma.TransactionClient): Promise<PayoutAccount> {
    const db = tx ?? this.prisma;
    const a = await db.payoutAccount.findFirst({ where: { ownerType: owner.ownerType, ownerId: owner.ownerId, status: { not: "INACTIVE" } } });
    if (!a) throw new AppError("PAYOUT_ACCOUNT_REQUIRED", 422, "Add a payout account before requesting a payout");
    if (a.status !== "VERIFIED") throw new AppError("PAYOUT_ACCOUNT_NOT_VERIFIED", 422, a.status === "FAILED" ? "Your payout account could not be verified; add a different one" : "Your payout account is still being verified", { status: a.status });
    if (this.clock.now() < a.cooldownUntil) {
      throw new AppError("PAYOUT_ACCOUNT_COOLDOWN", 409, "Payouts are paused for 24 hours after a payout account change", { until: a.cooldownUntil.toISOString() });
    }
    return a;
  }

  /**
   * fund_account.validation.completed / .failed. Only a PENDING account changes (a repeat, or an account replaced meanwhile, is a no-op).
   * An unknown fund account throws so the queue retries: the webhook can outrun the transaction that stores the account.
   */
  /** Why a payout to this account must not go ahead now, or null: replaced, not verified, held for review, or still in its post-change pause. */
  blockReason(a: Pick<PayoutAccount, "status" | "reviewFlag" | "cooldownUntil">): string | null {
    if (a.status === "INACTIVE") return "the payout account was replaced";
    if (a.status !== "VERIFIED") return "the payout account is not verified";
    if (a.reviewFlag) return `the payout account is held for review (${a.reviewFlag})`;
    if (this.clock.now() < a.cooldownUntil) return "the payout account was changed less than 24 hours ago";
    return null;
  }

  async onValidation(result: ValidationResult): Promise<void> {
    const account = await this.prisma.payoutAccount.findUnique({ where: { razorpayxFundAccountId: result.fundAccountId } });
    if (!account) throw new Error(`unknown fund account ${result.fundAccountId}: not stored yet, will retry`);
    if (account.status !== "PENDING") return;
    const ok = result.status === "completed" && result.accountStatus === "active";
    const nameMatch = result.registeredName ? namesMatch(result.registeredName, account.holderName) : null;
    const done = await this.prisma.payoutAccount.updateMany({
      where: { id: account.id, status: "PENDING" },
      data: ok
        ? { status: "VERIFIED", verifiedAt: this.clock.now(), panNameMatch: nameMatch, ...(nameMatch === false && !account.reviewFlag ? { reviewFlag: NAME_MISMATCH_FLAG } : {}) }
        : { status: "FAILED", failureReason: result.status === "completed" ? `The account is not valid (${result.accountStatus ?? "unknown"})` : "The account could not be validated", panNameMatch: nameMatch },
    });
    if (done.count > 0) this.logger.log(`payout account ${account.id} ${ok ? "verified" : "failed validation"}`);
  }

  /**
   * Finance reviewed a flagged account (DUPLICATE_PAN, NAME_MISMATCH) and clears the flag, which lets payouts to it through again.
   * Only the flag that is actually set can be cleared, so a stale click cannot clear a different problem. Audited with the note.
   */
  async clearFlag(actorId: string, accountId: string, flag: string, note: string | undefined, meta: MutationMeta = {}): Promise<AdminPayoutAccountView> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "payout_accounts" WHERE "id" = ${accountId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError("PAYOUT_ACCOUNT_NOT_FOUND", 404, "Payout account not found");
      const before = await tx.payoutAccount.findUniqueOrThrow({ where: { id: accountId } });
      if (before.reviewFlag !== flag) throw new AppError("PAYOUT_ACCOUNT_FLAG_NOT_SET", 409, `The account is not flagged ${flag}`, { reviewFlag: before.reviewFlag });
      const updated = await tx.payoutAccount.update({ where: { id: accountId }, data: { reviewFlag: null } });
      await this.audit.record(tx, { actorId, action: "payout_account.clear_flag", targetType: "payout_account", targetId: accountId, before: toAdminView(before), after: { ...toAdminView(updated), clearedFlag: flag, note: note ?? null }, ...meta });
      return toAdminView(updated);
    });
  }

  async listForReview(filter: { flagged?: boolean; status?: PayoutAccount["status"] }, page: PageQuery) {
    const rows = await this.prisma.payoutAccount.findMany({
      where: { ...(filter.flagged ? { reviewFlag: { not: null } } : {}), ...(filter.status ? { status: filter.status } : {}), ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toAdminView), nextCursor };
  }
}
