import { HttpRazorpayClient, RazorpayApiError } from "./razorpay.client";
import { FakeRazorpayClient } from "./razorpay.fake";
import { safeEqual, verifyWebhookSignature } from "./signature";

// Independent vectors (computed with openssl-equivalent HMAC-SHA256, not by the code under test).
const PAYMENT_SIG = "6c4490ce5c4839b0437f2b5dccb1fc7301518f94c6d1165b96d0903bfd33b2ae"; // key "secret", "order_abc|pay_xyz"
const WEBHOOK_BODY = '{"event":"payment.captured"}';
const WEBHOOK_SIG = "4673dd707ef4c41b987cb7fefe1583142dc702388c93145b7814b9ad3d3c183e"; // key "whsec"

describe("verifyPaymentSignature", () => {
  const client = new HttpRazorpayClient("rzp_test", "secret");
  const fake = new FakeRazorpayClient({ keySecret: "secret", webhookSecret: "whsec" });

  it.each([
    ["real client", client],
    ["fake client", fake],
  ])("%s: accepts the correct signature", (_name, c) => {
    expect(c.verifyPaymentSignature({ orderId: "order_abc", paymentId: "pay_xyz", signature: PAYMENT_SIG })).toBe(true);
  });

  it.each([
    ["wrong order", { orderId: "order_abd", paymentId: "pay_xyz", signature: PAYMENT_SIG }],
    ["wrong payment", { orderId: "order_abc", paymentId: "pay_xyy", signature: PAYMENT_SIG }],
    ["swapped ids", { orderId: "pay_xyz", paymentId: "order_abc", signature: PAYMENT_SIG }],
    ["one hex digit off", { orderId: "order_abc", paymentId: "pay_xyz", signature: PAYMENT_SIG.slice(0, -1) + "f" }],
    ["truncated (length mismatch)", { orderId: "order_abc", paymentId: "pay_xyz", signature: PAYMENT_SIG.slice(0, 63) }],
    ["too long", { orderId: "order_abc", paymentId: "pay_xyz", signature: PAYMENT_SIG + "0" }],
    ["empty signature", { orderId: "order_abc", paymentId: "pay_xyz", signature: "" }],
    ["empty order", { orderId: "", paymentId: "pay_xyz", signature: PAYMENT_SIG }],
    ["uppercase hex", { orderId: "order_abc", paymentId: "pay_xyz", signature: PAYMENT_SIG.toUpperCase() }],
  ])("rejects: %s", (_name, input) => {
    expect(client.verifyPaymentSignature(input)).toBe(false);
  });

  it("a signature made with another secret is rejected", () => {
    const other = new HttpRazorpayClient("rzp_test", "other-secret");
    expect(other.verifyPaymentSignature({ orderId: "order_abc", paymentId: "pay_xyz", signature: PAYMENT_SIG })).toBe(false);
  });

  it("the fake's checkout signature verifies on the real client with the same secret", () => {
    expect(client.verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature: fake.paymentSignature("order_1", "pay_1") })).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts the HMAC-SHA256 hex of the raw body", () => {
    expect(verifyWebhookSignature(Buffer.from(WEBHOOK_BODY), WEBHOOK_SIG, "whsec")).toBe(true);
    expect(verifyWebhookSignature(WEBHOOK_BODY, WEBHOOK_SIG, "whsec")).toBe(true);
  });
  it("rejects a changed body, wrong secret, missing, empty and wrong-length signatures", () => {
    expect(verifyWebhookSignature(Buffer.from(WEBHOOK_BODY + " "), WEBHOOK_SIG, "whsec")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(WEBHOOK_BODY), WEBHOOK_SIG, "other")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(WEBHOOK_BODY), undefined, "whsec")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(WEBHOOK_BODY), "", "whsec")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(WEBHOOK_BODY), WEBHOOK_SIG.slice(2), "whsec")).toBe(false);
  });
  it("safeEqual never throws on length mismatch or multi-byte input", () => {
    expect(safeEqual("a", "ab")).toBe(false);
    expect(safeEqual("é", "e")).toBe(false);
    expect(safeEqual("same", "same")).toBe(true);
  });
});

describe("HttpRazorpayClient (stubbed fetch)", () => {
  interface Seen {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: unknown;
  }
  function stub(responses: Array<{ status?: number; body: unknown }>) {
    const seen: Seen[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    }) as unknown as typeof fetch;
    return { seen, client: new HttpRazorpayClient("rzp_test_id", "key_secret", { fetch: fetchFn, baseUrl: "https://rzp.example/v1/" }) };
  }

  it("createOrder sends Basic auth, integer paise and INR, and returns bigint paise", async () => {
    const { seen, client } = stub([{ body: { id: "order_1", amount: 123400, currency: "INR", receipt: "r1", status: "created", notes: [] } }]);
    const order = await client.createOrder({ amountPaise: 123400n, receipt: "r1", notes: { orderId: "o1" } });
    expect(order).toEqual({ id: "order_1", amountPaise: 123400n, currency: "INR", receipt: "r1", status: "created", notes: {} });
    expect(seen[0].url).toBe("https://rzp.example/v1/orders");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.Authorization).toBe(`Basic ${Buffer.from("rzp_test_id:key_secret").toString("base64")}`);
    expect(seen[0].body).toEqual({ amount: 123400, currency: "INR", receipt: "r1", notes: { orderId: "o1" } });
  });

  it("fetchPayment maps the payment", async () => {
    const { seen, client } = stub([{ body: { id: "pay_1", order_id: "order_1", amount: 5000, currency: "INR", status: "captured", captured: true, method: "upi", amount_refunded: 0, notes: { a: 1 } } }]);
    expect(await client.fetchPayment("pay_1")).toEqual({ id: "pay_1", orderId: "order_1", amountPaise: 5000n, currency: "INR", status: "captured", captured: true, method: "upi", amountRefundedPaise: 0n, notes: { a: "1" } });
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://rzp.example/v1/payments/pay_1");
    expect(seen[0].body).toBeUndefined();
  });

  it("createRefund posts the partial amount to the payment's refund endpoint", async () => {
    const { seen, client } = stub([{ body: { id: "rfnd_1", payment_id: "pay_1", amount: 2500, status: "processed", notes: {} } }]);
    expect(await client.createRefund("pay_1", { amountPaise: 2500n, notes: { why: "x" } })).toMatchObject({ id: "rfnd_1", paymentId: "pay_1", amountPaise: 2500n });
    expect(seen[0].url).toBe("https://rzp.example/v1/payments/pay_1/refund");
    expect(seen[0].body).toEqual({ amount: 2500, notes: { why: "x" } });
  });

  it("createPlan, createSubscription and cancelSubscription use the documented bodies", async () => {
    const { seen, client } = stub([
      { body: { id: "plan_1", period: "monthly", interval: 1, item: { name: "Pro", amount: 99900 } } },
      { body: { id: "sub_1", plan_id: "plan_1", status: "created", short_url: "https://rzp.io/i/x" } },
      { body: { id: "sub_1", plan_id: "plan_1", status: "cancelled" } },
      { body: { id: "sub_1", plan_id: "plan_1", status: "active" } },
    ]);
    expect(await client.createPlan({ period: "monthly", interval: 1, name: "Pro", amountPaise: 99900n })).toEqual({ id: "plan_1", period: "monthly", interval: 1, name: "Pro", amountPaise: 99900n });
    expect(seen[0].body).toEqual({ period: "monthly", interval: 1, item: { name: "Pro", amount: 99900, currency: "INR" }, notes: {} });
    expect(await client.createSubscription({ planId: "plan_1", totalCount: 12 })).toEqual({ id: "sub_1", planId: "plan_1", status: "created", shortUrl: "https://rzp.io/i/x" });
    expect(seen[1].body).toEqual({ plan_id: "plan_1", total_count: 12, customer_notify: 1, notes: {} });
    await client.cancelSubscription("sub_1", false);
    expect(seen[2].url).toBe("https://rzp.example/v1/subscriptions/sub_1/cancel");
    expect(seen[2].body).toEqual({ cancel_at_cycle_end: 0 });
    await client.cancelSubscription("sub_1", true);
    expect(seen[3].body).toEqual({ cancel_at_cycle_end: 1 });
  });

  it("surfaces Razorpay errors as RazorpayApiError", async () => {
    const { client } = stub([{ status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "The amount must be atleast INR 1.00" } } }]);
    await expect(client.createOrder({ amountPaise: 10n, receipt: "r" })).rejects.toMatchObject({ name: "RazorpayApiError", status: 400, code: "BAD_REQUEST_ERROR" });
    const { client: c2 } = stub([{ status: 502, body: "<html>" }]);
    await expect(c2.fetchPayment("pay_1")).rejects.toBeInstanceOf(RazorpayApiError);
  });

  it("rejects amounts that cannot be sent as exact integers", async () => {
    const { seen, client } = stub([]);
    await expect(client.createOrder({ amountPaise: -1n, receipt: "r" })).rejects.toBeInstanceOf(RangeError);
    await expect(client.createOrder({ amountPaise: 2n ** 60n, receipt: "r" })).rejects.toBeInstanceOf(RangeError);
    expect(seen).toHaveLength(0);
  });
});

describe("FakeRazorpayClient.webhook", () => {
  const fake = new FakeRazorpayClient({ keySecret: "k", webhookSecret: "whsec", webhookXSecret: "whsecx" });

  it("builds a body whose signature verifies with the matching secret only", () => {
    const hook = fake.webhook("payment.captured", { payment: { entity: { id: "pay_1" } } });
    expect(JSON.parse(hook.body).event).toBe("payment.captured");
    expect(verifyWebhookSignature(hook.body, hook.headers["x-razorpay-signature"], "whsec")).toBe(true);
    expect(verifyWebhookSignature(hook.body, hook.headers["x-razorpay-signature"], "whsecx")).toBe(false);
    const x = fake.webhook("payout.processed", {}, { provider: "RAZORPAYX" });
    expect(verifyWebhookSignature(x.body, x.headers["x-razorpay-signature"], "whsecx")).toBe(true);
  });

  it("gives each webhook a fresh event id unless one is supplied", () => {
    const a = fake.webhook("x");
    const b = fake.webhook("x");
    expect(a.headers["x-razorpay-event-id"]).not.toBe(b.headers["x-razorpay-event-id"]);
    expect(fake.webhook("x", {}, { eventId: "evt_fixed" }).headers["x-razorpay-event-id"]).toBe("evt_fixed");
  });

  it("records calls and can fail the next call of a method", async () => {
    const order = await fake.createOrder({ amountPaise: 1000n, receipt: "r1" });
    expect(fake.callsTo("createOrder")).toHaveLength(1);
    const payment = fake.capturePayment(order.id);
    expect((await fake.fetchPayment(payment.id)).amountPaise).toBe(1000n);
    fake.failNext.set("createRefund", new Error("gateway down"));
    await expect(fake.createRefund(payment.id, { amountPaise: 100n })).rejects.toThrow("gateway down");
    expect((await fake.createRefund(payment.id, { amountPaise: 100n })).amountPaise).toBe(100n);
  });
});
