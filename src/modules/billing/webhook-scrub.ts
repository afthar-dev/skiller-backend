import { last4, maskVpa } from "./kyc";

const MAX_DEPTH = 12;

/** A VPA arrives as a string or as `{ username, handle, address }`; only a masked `address` survives, never the parts of the UPI id. */
function scrubVpa(v: unknown): unknown {
  if (typeof v === "string") return maskVpa(v);
  if (v && typeof v === "object") {
    const o = v as { address?: unknown; username?: unknown; handle?: unknown };
    const full = typeof o.address === "string" ? o.address : typeof o.username === "string" ? `${o.username}@${typeof o.handle === "string" ? o.handle : ""}` : null;
    return { address: full ? maskVpa(full) : "***" };
  }
  return v;
}

/**
 * RazorpayX events about fund accounts carry the beneficiary's bank details in full. We never store those: before an event is saved,
 * every `account_number` is cut to its last four digits, every `vpa` is reduced to a masked `address` (username and handle are dropped) and any `pan` is cut to its last four.
 * Runs on the parsed copy only; the signature has already been checked against the raw body.
 */
export function scrubPayoutDetails(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => scrubPayoutDetails(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "account_number" || key === "pan") && typeof v === "string") out[key] = `****${last4(v)}`;
    else if (key === "vpa") out[key] = scrubVpa(v);
    else out[key] = scrubPayoutDetails(v, depth + 1);
  }
  return out;
}
