import type { Request } from "express";
import { ipKey } from "../../common/redis/ip-key";
import type { RateLimitOptions } from "../../common/redis/rate-limit.decorator";
import { normalizeEmail } from "./otp.service";

const WINDOW_15_MIN = 15 * 60;

const emailOf = (req: Request): string | null => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.length <= 254 ? normalizeEmail(email) : null;
};

/**
 * otp/request. Limits are per address AND per caller (IPv6 by /64), never per address alone: a stranger who hammers an address
 * only uses up his own allowance and cannot make the owner's requests fail. Total sends to one address are bounded separately
 * inside OtpService (hourly ceiling), which never rejects the owner.
 */
export const OTP_REQUEST_LIMITS: RateLimitOptions[] = [
  { key: (req) => `otp:email-ip:${emailOf(req) ?? "invalid"}:${ipKey(req.ip)}`, limit: 3, windowSec: WINDOW_15_MIN },
  { key: (req) => `otp:ip:${ipKey(req.ip)}`, limit: 20, windowSec: WINDOW_15_MIN },
];

/** otp/verify: guesses per caller; the per-email cap across challenges lives in OtpService. */
export const OTP_VERIFY_LIMITS: RateLimitOptions[] = [{ key: (req) => `otp-verify:ip:${ipKey(req.ip)}`, limit: 30, windowSec: WINDOW_15_MIN }];
