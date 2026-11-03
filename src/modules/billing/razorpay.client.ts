import { fromGatewayAmount, type Paise } from "./money";
import { verifyPaymentSignature } from "./signature";

/** DI token. Everything outside this file depends on the interface; tests inject FakeRazorpayClient. */
export const RAZORPAY_CLIENT = Symbol("RAZORPAY_CLIENT");

export type RazorpayNotes = Record<string, string>;

export interface RazorpayOrder {
  id: string;
  amountPaise: Paise;
  currency: string;
  receipt: string | null;
  status: string;
  notes: RazorpayNotes;
}

export interface RazorpayPayment {
  id: string;
  orderId: string | null;
  amountPaise: Paise;
  currency: string;
  /** created | authorized | captured | refunded | failed */
  status: string;
  captured: boolean;
  method: string | null;
  amountRefundedPaise: Paise;
  notes: RazorpayNotes;
}

export interface RazorpayRefund {
  id: string;
  paymentId: string;
  amountPaise: Paise;
  status: string;
  notes: RazorpayNotes;
}

export type RazorpayPeriod = "daily" | "weekly" | "monthly" | "yearly";

export interface CreatePlanInput {
  period: RazorpayPeriod;
  interval: number;
  name: string;
  amountPaise: Paise;
  description?: string;
  notes?: RazorpayNotes;
}

export interface RazorpayPlan {
  id: string;
  period: string;
  interval: number;
  name: string;
  amountPaise: Paise;
}

export interface CreateSubscriptionInput {
  planId: string;
  /** Number of billing cycles before the subscription completes. */
  totalCount: number;
  /** Unix seconds; omit to start on the first successful authentication payment. */
  startAt?: number;
  customerNotify?: boolean;
  notes?: RazorpayNotes;
}

export interface RazorpaySubscription {
  id: string;
  planId: string;
  status: string;
  shortUrl: string | null;
}

export interface RazorpayClient {
  createOrder(input: { amountPaise: Paise; receipt: string; notes?: RazorpayNotes }): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
  createRefund(paymentId: string, input: { amountPaise: Paise; notes?: RazorpayNotes }): Promise<RazorpayRefund>;
  createPlan(input: CreatePlanInput): Promise<RazorpayPlan>;
  createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription>;
  cancelSubscription(subscriptionId: string, atCycleEnd: boolean): Promise<RazorpaySubscription>;
  /** HMAC-SHA256 hex of `orderId|paymentId` with the key secret, compared in constant time. */
  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
}

export class RazorpayApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    description: string,
  ) {
    super(`Razorpay ${status}${code ? ` ${code}` : ""}: ${description}`);
    this.name = "RazorpayApiError";
  }
}

const toApiAmount = (p: Paise): number => {
  if (p < 0n || p > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("amount is outside the range Razorpay accepts");
  return Number(p);
};

interface RawAmounts {
  [key: string]: unknown;
}

const num = fromGatewayAmount;

const notesOf = (v: unknown): RazorpayNotes => {
  // Razorpay returns [] for "no notes" instead of {}.
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)]));
};

export interface HttpRazorpayClientOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Razorpay REST API over fetch with Basic auth (key id : key secret). The official `razorpay` SDK is a thin wrapper over the
 * same endpoints and brings axios; amounts cross this boundary as integer paise only.
 */
export class HttpRazorpayClient implements RazorpayClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authorization: string;

  constructor(
    keyId: string,
    private readonly keySecret: string,
    opts: HttpRazorpayClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? "https://api.razorpay.com/v1").replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<RawAmounts> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: RawAmounts = {};
    try {
      json = text ? (JSON.parse(text) as RawAmounts) : {};
    } catch {
      if (res.ok) throw new RazorpayApiError(res.status, null, "response was not JSON");
    }
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; description?: string };
      throw new RazorpayApiError(res.status, err.code ?? null, err.description ?? `request failed (${path})`);
    }
    return json;
  }

  async createOrder(input: { amountPaise: Paise; receipt: string; notes?: RazorpayNotes }): Promise<RazorpayOrder> {
    const o = await this.call("POST", "/orders", { amount: toApiAmount(input.amountPaise), currency: "INR", receipt: input.receipt, notes: input.notes ?? {} });
    return { id: String(o.id), amountPaise: num(o.amount), currency: String(o.currency), receipt: (o.receipt as string | null) ?? null, status: String(o.status), notes: notesOf(o.notes) };
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const p = await this.call("GET", `/payments/${encodeURIComponent(paymentId)}`);
    return {
      id: String(p.id),
      orderId: (p.order_id as string | null) ?? null,
      amountPaise: num(p.amount),
      currency: String(p.currency),
      status: String(p.status),
      captured: p.captured === true,
      method: (p.method as string | null) ?? null,
      amountRefundedPaise: p.amount_refunded === undefined || p.amount_refunded === null ? 0n : num(p.amount_refunded),
      notes: notesOf(p.notes),
    };
  }

  async createRefund(paymentId: string, input: { amountPaise: Paise; notes?: RazorpayNotes }): Promise<RazorpayRefund> {
    const r = await this.call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: toApiAmount(input.amountPaise), notes: input.notes ?? {} });
    return { id: String(r.id), paymentId: String(r.payment_id), amountPaise: num(r.amount), status: String(r.status), notes: notesOf(r.notes) };
  }

  async createPlan(input: CreatePlanInput): Promise<RazorpayPlan> {
    const p = await this.call("POST", "/plans", {
      period: input.period,
      interval: input.interval,
      item: { name: input.name, amount: toApiAmount(input.amountPaise), currency: "INR", ...(input.description ? { description: input.description } : {}) },
      notes: input.notes ?? {},
    });
    const item = (p.item ?? {}) as RawAmounts;
    return { id: String(p.id), period: String(p.period), interval: Number(p.interval), name: String(item.name ?? input.name), amountPaise: num(item.amount) };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription> {
    const s = await this.call("POST", "/subscriptions", {
      plan_id: input.planId,
      total_count: input.totalCount,
      customer_notify: input.customerNotify === false ? 0 : 1,
      ...(input.startAt === undefined ? {} : { start_at: input.startAt }),
      notes: input.notes ?? {},
    });
    return { id: String(s.id), planId: String(s.plan_id), status: String(s.status), shortUrl: (s.short_url as string | null) ?? null };
  }

  async cancelSubscription(subscriptionId: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
    const s = await this.call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
    return { id: String(s.id), planId: String(s.plan_id), status: String(s.status), shortUrl: (s.short_url as string | null) ?? null };
  }

  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    return verifyPaymentSignature(this.keySecret, input);
  }
}
