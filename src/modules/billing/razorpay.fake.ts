import { randomUUID } from "node:crypto";
import type {
  CreatePlanInput,
  CreateSubscriptionInput,
  RazorpayClient,
  RazorpayNotes,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayPlan,
  RazorpayRefund,
  RazorpaySubscription,
} from "./razorpay.client";
import type { Paise } from "./money";
import { hmacSha256Hex, verifyPaymentSignature } from "./signature";

export interface FakeRazorpaySecrets {
  keySecret: string;
  webhookSecret: string;
  /** Used for webhooks built with `{ provider: "RAZORPAYX" }`. */
  webhookXSecret?: string;
}

export interface FakeWebhook {
  /** The exact raw body that was signed: post it as-is. */
  body: string;
  headers: Record<string, string>;
}

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

/** In-memory Razorpay: records every call, and builds correctly signed webhook requests and checkout signatures for tests. */
export class FakeRazorpayClient implements RazorpayClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly orders = new Map<string, RazorpayOrder>();
  readonly payments = new Map<string, RazorpayPayment>();
  readonly refunds: RazorpayRefund[] = [];
  readonly plans = new Map<string, RazorpayPlan>();
  readonly subscriptions = new Map<string, RazorpaySubscription>();
  /** When set, the next call to that method rejects with this error (then clears). */
  failNext = new Map<string, Error>();

  constructor(private readonly secrets: FakeRazorpaySecrets) {}

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

  async createOrder(input: { amountPaise: Paise; receipt: string; notes?: RazorpayNotes }): Promise<RazorpayOrder> {
    this.record("createOrder", input);
    const order: RazorpayOrder = { id: id("order"), amountPaise: input.amountPaise, currency: "INR", receipt: input.receipt, status: "created", notes: input.notes ?? {} };
    this.orders.set(order.id, order);
    return order;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    this.record("fetchPayment", paymentId);
    const p = this.payments.get(paymentId);
    if (!p) throw new Error(`fake razorpay: unknown payment ${paymentId}`);
    return p;
  }

  private readonly refundsByKey = new Map<string, RazorpayRefund>();

  async createRefund(paymentId: string, input: { amountPaise: Paise; notes?: RazorpayNotes; idempotencyKey?: string }): Promise<RazorpayRefund> {
    this.record("createRefund", paymentId, input);
    const repeated = input.idempotencyKey ? this.refundsByKey.get(input.idempotencyKey) : undefined;
    if (repeated) return repeated;
    const refund: RazorpayRefund = { id: id("rfnd"), paymentId, amountPaise: input.amountPaise, status: "processed", notes: input.notes ?? {} };
    this.refunds.push(refund);
    if (input.idempotencyKey) this.refundsByKey.set(input.idempotencyKey, refund);
    const p = this.payments.get(paymentId);
    if (p) this.payments.set(paymentId, { ...p, amountRefundedPaise: p.amountRefundedPaise + input.amountPaise, status: p.amountRefundedPaise + input.amountPaise >= p.amountPaise ? "refunded" : p.status });
    return refund;
  }

  async listRefunds(paymentId: string): Promise<RazorpayRefund[]> {
    this.record("listRefunds", paymentId);
    return this.refunds.filter((r) => r.paymentId === paymentId);
  }

  async createPlan(input: CreatePlanInput): Promise<RazorpayPlan> {
    this.record("createPlan", input);
    const plan: RazorpayPlan = { id: id("plan"), period: input.period, interval: input.interval, name: input.name, amountPaise: input.amountPaise };
    this.plans.set(plan.id, plan);
    return plan;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription> {
    this.record("createSubscription", input);
    const sub: RazorpaySubscription = { id: id("sub"), planId: input.planId, status: "created", shortUrl: `https://rzp.test/i/${randomUUID().slice(0, 8)}` };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  async cancelSubscription(subscriptionId: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
    this.record("cancelSubscription", subscriptionId, atCycleEnd);
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`fake razorpay: unknown subscription ${subscriptionId}`);
    const updated = { ...sub, status: atCycleEnd ? sub.status : "cancelled" };
    this.subscriptions.set(subscriptionId, updated);
    return updated;
  }

  async updateSubscription(subscriptionId: string, input: { planId: string; atCycleEnd: boolean }): Promise<RazorpaySubscription> {
    this.record("updateSubscription", subscriptionId, input);
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`fake razorpay: unknown subscription ${subscriptionId}`);
    // At cycle end the subscription keeps its current plan until the renewal; a test then simulates that charge itself.
    const updated = input.atCycleEnd ? sub : { ...sub, planId: input.planId };
    this.subscriptions.set(subscriptionId, updated);
    return updated;
  }

  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    return verifyPaymentSignature(this.secrets.keySecret, input);
  }

  // ── test helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** What Razorpay Checkout would hand the browser after a successful payment of `orderId`. */
  paymentSignature(orderId: string, paymentId: string): string {
    return hmacSha256Hex(this.secrets.keySecret, `${orderId}|${paymentId}`);
  }

  /** Registers a captured payment against an existing fake order and returns it. */
  capturePayment(orderId: string, overrides: Partial<RazorpayPayment> = {}): RazorpayPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake razorpay: unknown order ${orderId}`);
    const payment: RazorpayPayment = {
      id: id("pay"),
      orderId,
      amountPaise: order.amountPaise,
      currency: order.currency,
      status: "captured",
      captured: true,
      method: "upi",
      amountRefundedPaise: 0n,
      notes: order.notes,
      ...overrides,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  /**
   * A signed webhook request. `payload` is the event's inner `payload` object (e.g. `{ payment: { entity: {...} } }`).
   * Each call gets a fresh event id unless `eventId` is given (use the same one to simulate a redelivery).
   */
  webhook(type: string, payload: Record<string, unknown> = {}, opts: { eventId?: string; provider?: "RAZORPAY" | "RAZORPAYX" } = {}): FakeWebhook {
    const body = JSON.stringify({ entity: "event", account_id: "acc_fake", event: type, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
    const secret = opts.provider === "RAZORPAYX" ? (this.secrets.webhookXSecret ?? this.secrets.webhookSecret) : this.secrets.webhookSecret;
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": hmacSha256Hex(secret, body),
        "x-razorpay-event-id": opts.eventId ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      },
    };
  }
}
