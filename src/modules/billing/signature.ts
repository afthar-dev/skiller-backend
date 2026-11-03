import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time string comparison; strings of different length are simply unequal (timingSafeEqual would throw). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Razorpay webhooks: X-Razorpay-Signature = HMAC-SHA256 (hex) of the raw request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  return safeEqual(hmacSha256Hex(secret, rawBody), signature.trim());
}

/** Razorpay Checkout: razorpay_signature = HMAC-SHA256 (hex) of `orderId|paymentId` with the API key secret. */
export function verifyPaymentSignature(keySecret: string, input: { orderId: string; paymentId: string; signature: string }): boolean {
  if (!input.orderId || !input.paymentId || !input.signature) return false;
  return safeEqual(hmacSha256Hex(keySecret, `${input.orderId}|${input.paymentId}`), input.signature.trim());
}
