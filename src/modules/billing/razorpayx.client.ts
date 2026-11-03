import { fromGatewayAmount, type Paise } from "./money";
import { RazorpayApiError } from "./razorpay.client";

/** DI token. Everything outside this file depends on the interface; tests inject FakeRazorpayXClient. */
export const RAZORPAYX_CLIENT = Symbol("RAZORPAYX_CLIENT");

export type PayoutMode = "IMPS" | "UPI" | "NEFT";

export interface RazorpayXContact {
  id: string;
}

export interface RazorpayXFundAccount {
  id: string;
  accountType: "bank_account" | "vpa";
}

export interface RazorpayXValidation {
  id: string;
  fundAccountId: string;
  /** created | completed | failed */
  status: string;
}

export interface RazorpayXPayout {
  id: string;
  fundAccountId: string;
  amountPaise: Paise;
  mode: string;
  /** Our payout id: set when the payout is created and the key to find it again after a crash. */
  referenceId: string | null;
  /** queued | pending | processing | processed | reversed | cancelled | rejected | failed */
  status: string;
  utr: string | null;
  failureReason: string | null;
}

export interface CreatePayoutInput {
  fundAccountId: string;
  amountPaise: Paise;
  mode: PayoutMode;
  referenceId: string;
  /** Repeating a call with the same key returns the first payout instead of paying twice. */
  idempotencyKey: string;
  narration?: string;
}

export interface CreateFundAccountInput {
  contactId: string;
  /** Exactly one of `bank` / `vpa`. The full values go to RazorpayX here and nowhere else. */
  bank?: { name: string; ifsc: string; accountNumber: string };
  vpa?: { address: string };
}

/**
 * RazorpayX: contacts, fund accounts (bank account or UPI id), their validation (penny drop) and payouts.
 * Full bank account numbers and UPI ids pass through `createFundAccount` only; they are never stored or logged by us.
 */
export interface RazorpayXClient {
  createContact(input: { name: string; referenceId: string }): Promise<RazorpayXContact>;
  createFundAccount(input: CreateFundAccountInput): Promise<RazorpayXFundAccount>;
  /** Starts the validation; the result arrives as the fund_account.validation.completed webhook. */
  validateFundAccount(input: { fundAccountId: string; referenceId: string }): Promise<RazorpayXValidation>;
  createPayout(input: CreatePayoutInput): Promise<RazorpayXPayout>;
  fetchPayout(payoutId: string): Promise<RazorpayXPayout>;
  /** The payout created for our `referenceId`, or null. Used to adopt a payout whose creation was not recorded (a crash after the call). */
  findPayoutByReference(referenceId: string): Promise<RazorpayXPayout | null>;
}

type Raw = Record<string, unknown>;

const toApiAmount = (p: Paise): number => {
  if (p <= 0n || p > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("amount is outside the range RazorpayX accepts");
  return Number(p);
};

export interface HttpRazorpayXClientOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** RazorpayX REST API over fetch with Basic auth (key id : key secret); `accountNumber` is the current account the payouts debit. */
export class HttpRazorpayXClient implements RazorpayXClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authorization: string;

  constructor(
    keyId: string,
    keySecret: string,
    private readonly accountNumber: string,
    opts: HttpRazorpayXClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? "https://api.razorpay.com/v1").replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Raw> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: Raw = {};
    try {
      json = text ? (JSON.parse(text) as Raw) : {};
    } catch {
      if (res.ok) throw new RazorpayApiError(res.status, null, "response was not JSON");
    }
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; description?: string };
      // The description of a fund-account error can echo what we sent: keep only the code and a generic line for those paths.
      throw new RazorpayApiError(res.status, err.code ?? null, err.description ?? `request failed (${method} ${path.split("?")[0]})`);
    }
    return json;
  }

  async createContact(input: { name: string; referenceId: string }): Promise<RazorpayXContact> {
    const c = await this.call("POST", "/contacts", { name: input.name, type: "vendor", reference_id: input.referenceId });
    return { id: String(c.id) };
  }

  async createFundAccount(input: CreateFundAccountInput): Promise<RazorpayXFundAccount> {
    if (!!input.bank === !!input.vpa) throw new TypeError("a fund account is either a bank account or a vpa");
    const f = await this.call(
      "POST",
      "/fund_accounts",
      input.bank
        ? { contact_id: input.contactId, account_type: "bank_account", bank_account: { name: input.bank.name, ifsc: input.bank.ifsc, account_number: input.bank.accountNumber } }
        : { contact_id: input.contactId, account_type: "vpa", vpa: { address: input.vpa!.address } },
    );
    return { id: String(f.id), accountType: f.account_type === "vpa" ? "vpa" : "bank_account" };
  }

  async validateFundAccount(input: { fundAccountId: string; referenceId: string }): Promise<RazorpayXValidation> {
    const v = await this.call("POST", "/fund_accounts/validations", {
      account_number: this.accountNumber,
      fund_account: { id: input.fundAccountId },
      amount: 100,
      currency: "INR",
      reference_id: input.referenceId,
    });
    return { id: String(v.id), fundAccountId: input.fundAccountId, status: String(v.status) };
  }

  private toPayout(p: Raw): RazorpayXPayout {
    return {
      id: String(p.id),
      fundAccountId: String(p.fund_account_id),
      amountPaise: fromGatewayAmount(p.amount),
      mode: String(p.mode ?? ""),
      referenceId: str(p.reference_id),
      status: String(p.status),
      utr: str(p.utr),
      failureReason: str(p.failure_reason) ?? str((p.status_details as Raw | undefined)?.description),
    };
  }

  async createPayout(input: CreatePayoutInput): Promise<RazorpayXPayout> {
    const p = await this.call(
      "POST",
      "/payouts",
      {
        account_number: this.accountNumber,
        fund_account_id: input.fundAccountId,
        amount: toApiAmount(input.amountPaise),
        currency: "INR",
        mode: input.mode,
        purpose: "payout",
        queue_if_low_balance: true,
        reference_id: input.referenceId,
        ...(input.narration ? { narration: input.narration.slice(0, 30) } : {}),
      },
      { "X-Payout-Idempotency": input.idempotencyKey },
    );
    return this.toPayout(p);
  }

  async fetchPayout(payoutId: string): Promise<RazorpayXPayout> {
    return this.toPayout(await this.call("GET", `/payouts/${encodeURIComponent(payoutId)}`));
  }

  async findPayoutByReference(referenceId: string): Promise<RazorpayXPayout | null> {
    const res = await this.call("GET", `/payouts?account_number=${encodeURIComponent(this.accountNumber)}&reference_id=${encodeURIComponent(referenceId)}&count=10`);
    const items = Array.isArray(res.items) ? (res.items as Raw[]) : [];
    const match = items.find((p) => p.reference_id === referenceId);
    return match ? this.toPayout(match) : null;
  }
}
