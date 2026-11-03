import { last4, maskVpa } from "./kyc";

const MAX_DEPTH = 12;

/**
 * RazorpayX events about fund accounts carry the beneficiary's bank details in full. We never store those: before an event is saved,
 * every `account_number` is cut to its last four digits, every `vpa.address` is masked and any `pan` is cut to its last four.
 * Runs on the parsed copy only; the signature has already been checked against the raw body.
 */
export function scrubPayoutDetails(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => scrubPayoutDetails(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "account_number" || key === "pan") && typeof v === "string") out[key] = `****${last4(v)}`;
    else if (key === "vpa" && v && typeof v === "object" && typeof (v as { address?: unknown }).address === "string") out[key] = { ...(scrubPayoutDetails(v, depth + 1) as object), address: maskVpa((v as { address: string }).address) };
    else out[key] = scrubPayoutDetails(v, depth + 1);
  }
  return out;
}
