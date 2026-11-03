import { createHmac } from "node:crypto";

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_NUMBER_PATTERN = /^[0-9]{9,18}$/;
export const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

/** `asha@okhdfc` -> `as***@okhdfc`. The handle (the bank) stays, the person part is hidden. */
export function maskVpa(vpa: string): string {
  const at = vpa.lastIndexOf("@");
  if (at < 1) return "***";
  return `${vpa.slice(0, Math.min(2, at))}***${vpa.slice(at)}`;
}

export const last4 = (value: string): string => value.slice(-4);

/**
 * Keyed hash of a PAN (HMAC-SHA256 with the KYC pepper, hex). The PAN itself is never stored: this value only answers
 * "is the same PAN on two accounts?", and cannot be brute-forced offline without the pepper (a PAN has ~10^9 possibilities).
 */
export function panHash(pepper: string, pan: string): string {
  return createHmac("sha256", pepper).update(`pan:${pan.toUpperCase()}`).digest("hex");
}

const tokens = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Loose match between the name a bank reports and the holder name given: equal, or every word of the shorter name is in the longer. */
export function namesMatch(a: string, b: string): boolean {
  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 || right.length === 0) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.every((t) => long.includes(t));
}
