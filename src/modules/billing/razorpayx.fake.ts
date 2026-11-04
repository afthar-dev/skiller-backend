import { randomUUID } from "node:crypto";
import type { FakeWebhook } from "./razorpay.fake";
import type {
  CreateFundAccountInput,
  CreatePayoutInput,
  RazorpayXClient,
  RazorpayXContact,
  RazorpayXFundAccount,
  RazorpayXPayout,
  RazorpayXValidation,
} from "./razorpayx.client";
import { hmacSha256Hex } from "./signature";
import type { Paise } from "./money";

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

export type FakePayoutEvent = "payout.processed" | "payout.reversed" | "payout.failed" | "payout.rejected";

/** What the fake remembers about a fund account: the FULL values RazorpayX was sent (tests assert they never reach our database or logs). */
export interface FakeFundAccount {
  id: string;
  contactId: string;
  bank?: { name: string; ifsc: string; accountNumber: string };
  vpa?: { address: string };
}

/** In-memory RazorpayX: records every call, honours payout idempotency keys, and builds correctly signed webhook requests. */
export class FakeRazorpayXClient implements RazorpayXClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly contacts = new Map<string, { id: string; name: string; referenceId: string }>();
  readonly fundAccounts = new Map<string, FakeFundAccount>();
  readonly validations = new Map<string, RazorpayXValidation>();
  readonly payouts = new Map<string, RazorpayXPayout>();
  private readonly payoutsByKey = new Map<string, RazorpayXPayout>();
  /** When set, the next call to that method rejects with this error (then clears). */
  failNext = new Map<string, Error>();
  /** When true, createPayout creates the payout at RazorpayX but throws afterwards, like a timeout after the request was accepted. */
  loseNextPayoutResponse = false;

  constructor(private readonly secrets: { webhookSecret: string }) {}

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    const err = this.failNext.get(method);
    if (err) {
      this.failNext.delete(method);
      throw err;
    }
  }

  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  async createContact(input: { name: string; referenceId: string }): Promise<RazorpayXContact> {
    this.record("createContact", input);
    const c = { id: id("cont"), name: input.name, referenceId: input.referenceId };
    this.contacts.set(c.id, c);
    return { id: c.id };
  }

  async createFundAccount(input: CreateFundAccountInput): Promise<RazorpayXFundAccount> {
    this.record("createFundAccount", input);
    const f: FakeFundAccount = { id: id("fa"), contactId: input.contactId, ...(input.bank ? { bank: { ...input.bank } } : {}), ...(input.vpa ? { vpa: { ...input.vpa } } : {}) };
    this.fundAccounts.set(f.id, f);
    return { id: f.id, accountType: input.vpa ? "vpa" : "bank_account" };
  }

  async validateFundAccount(input: { fundAccountId: string; referenceId: string }): Promise<RazorpayXValidation> {
    this.record("validateFundAccount", input);
    if (!this.fundAccounts.has(input.fundAccountId)) throw new Error(`fake razorpayx: unknown fund account ${input.fundAccountId}`);
    const v: RazorpayXValidation = { id: id("fav"), fundAccountId: input.fundAccountId, status: "created" };
    this.validations.set(v.id, v);
    return v;
  }

  async createPayout(input: CreatePayoutInput): Promise<RazorpayXPayout> {
    this.record("createPayout", input);
    const repeated = this.payoutsByKey.get(input.idempotencyKey);
    if (repeated) return repeated;
    if (!this.fundAccounts.has(input.fundAccountId)) throw new Error(`fake razorpayx: unknown fund account ${input.fundAccountId}`);
    const p: RazorpayXPayout = { id: id("pout"), fundAccountId: input.fundAccountId, amountPaise: input.amountPaise, mode: input.mode, referenceId: input.referenceId, status: "processing", utr: null, failureReason: null };
    this.payouts.set(p.id, p);
    this.payoutsByKey.set(input.idempotencyKey, p);
    if (this.loseNextPayoutResponse) {
      this.loseNextPayoutResponse = false;
      throw new Error("fake razorpayx: connection reset after the payout was created");
    }
    return p;
  }

  async fetchPayout(payoutId: string): Promise<RazorpayXPayout> {
    this.record("fetchPayout", payoutId);
    const p = this.payouts.get(payoutId);
    if (!p) throw new Error(`fake razorpayx: unknown payout ${payoutId}`);
    return p;
  }

  async findPayoutByReference(referenceId: string): Promise<RazorpayXPayout | null> {
    this.record("findPayoutByReference", referenceId);
    return [...this.payouts.values()].find((p) => p.referenceId === referenceId) ?? null;
  }

  // ── test helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

  private signed(type: string, payload: Record<string, unknown>, eventId?: string): FakeWebhook {
    const body = JSON.stringify({ entity: "event", account_id: "acc_fake_x", event: type, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": hmacSha256Hex(this.secrets.webhookSecret, body),
        "x-razorpay-event-id": eventId ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      },
    };
  }

  /**
   * fund_account.validation.completed (or .failed) for a fund account. Like the real payload it carries the fund account's bank details
   * in full, so tests can prove we scrub them before storing the event.
   */
  validationWebhook(fundAccountId: string, outcome: "active" | "invalid" | "failed" = "active", opts: { eventId?: string; registeredName?: string } = {}): FakeWebhook {
    const fa = this.fundAccounts.get(fundAccountId);
    if (!fa) throw new Error(`fake razorpayx: unknown fund account ${fundAccountId}`);
    const entity = {
      id: [...this.validations.values()].find((v) => v.fundAccountId === fundAccountId)?.id ?? id("fav"),
      entity: "fund_account.validation",
      status: outcome === "failed" ? "failed" : "completed",
      fund_account: {
        id: fa.id,
        entity: "fund_account",
        contact_id: fa.contactId,
        ...(fa.bank ? { account_type: "bank_account", bank_account: { name: fa.bank.name, ifsc: fa.bank.ifsc, account_number: fa.bank.accountNumber } } : { account_type: "vpa", vpa: { address: fa.vpa!.address } }),
      },
      results: { account_status: outcome === "failed" ? null : outcome, registered_name: opts.registeredName ?? fa.bank?.name ?? null },
    };
    return this.signed(outcome === "failed" ? "fund_account.validation.failed" : "fund_account.validation.completed", { "fund_account.validation": { entity } }, opts.eventId);
  }

  /** payout.processed / reversed / failed / rejected for a payout RazorpayX holds (or, with `raw`, for any entity values). */
  payoutWebhook(type: FakePayoutEvent, payoutId: string, opts: { eventId?: string; utr?: string; failureReason?: string; amountPaise?: Paise; omitAmount?: boolean } = {}): FakeWebhook {
    const p = this.payouts.get(payoutId);
    if (!p) throw new Error(`fake razorpayx: unknown payout ${payoutId}`);
    const status = { "payout.processed": "processed", "payout.reversed": "reversed", "payout.failed": "failed", "payout.rejected": "rejected" }[type];
    const entity = {
      id: p.id,
      entity: "payout",
      fund_account_id: p.fundAccountId,
      ...(opts.omitAmount ? {} : { amount: Number(opts.amountPaise ?? p.amountPaise) }),
      currency: "INR",
      mode: p.mode,
      reference_id: p.referenceId,
      status,
      utr: opts.utr ?? (type === "payout.processed" || type === "payout.reversed" ? `UTR${p.id.slice(-8)}` : null),
      failure_reason: opts.failureReason ?? (type === "payout.processed" ? null : "Beneficiary bank rejected the payment"),
    };
    return this.signed(type, { payout: { entity } }, opts.eventId);
  }

  /** The same event for a payout id we do not know at all (webhook before the row was stored, or somebody else's payout). */
  unknownPayoutWebhook(type: FakePayoutEvent, entity: { id: string; referenceId?: string | null; amountPaise: Paise }, opts: { eventId?: string } = {}): FakeWebhook {
    return this.signed(type, { payout: { entity: { id: entity.id, entity: "payout", amount: Number(entity.amountPaise), currency: "INR", reference_id: entity.referenceId ?? null, status: type.split(".")[1] } } }, opts.eventId);
  }
}
