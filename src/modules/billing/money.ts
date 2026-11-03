import { AppError } from "../../common/errors/app-error";

/** Money is integer paise held as bigint. No floats anywhere: rates are integer basis points (1 bps = 0.01%). */
export type Paise = bigint;

const BPS_DENOMINATOR = 10_000n;

function assertPaise(value: Paise, name: string): void {
  if (typeof value !== "bigint") throw new RangeError(`${name} must be a bigint (paise)`);
  if (value < 0n) throw new RangeError(`${name} must not be negative`);
}

function assertBps(bps: number, name: string, max: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) throw new RangeError(`${name} must be an integer between 0 and ${max}`);
}

/** round(n / d) with halves rounded up, for n >= 0 and d > 0. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/** `part` = round-half-up(amount x bps / 10000); `rest` = amount - part, so a remainder always stays with `rest`. */
export function splitBps(amount: Paise, bps: number): { part: Paise; rest: Paise } {
  assertPaise(amount, "amount");
  assertBps(bps, "bps", 10_000);
  const part = divRoundHalfUp(amount * BigInt(bps), BPS_DENOMINATOR);
  return { part, rest: amount - part };
}

/** Splits a GST-inclusive fee: net = round(fee x 10000 / (10000 + gstBps)), tax = fee - net. */
export function gstSplit(fee: Paise, gstBps: number): { net: Paise; tax: Paise } {
  assertPaise(fee, "fee");
  assertBps(gstBps, "gstBps", 10_000);
  const net = divRoundHalfUp(fee * BPS_DENOMINATOR, BPS_DENOMINATOR + BigInt(gstBps));
  return { net, tax: fee - net };
}

/** Wire format: a decimal string, so JSON never loses precision. */
export function toApi(p: Paise): string {
  return p.toString();
}

/** Parses a plain integer string (no sign unless `allowNegative`, no decimals, no exponent, no padding). */
export function fromApi(s: string, opts: { allowNegative?: boolean } = {}): Paise {
  if (typeof s !== "string") throw new RangeError("amount must be a string of digits");
  const pattern = opts.allowNegative ? /^(0|-?[1-9]\d*)$/ : /^(0|[1-9]\d*)$/;
  if (!pattern.test(s)) throw new RangeError(opts.allowNegative ? "amount must be an integer number of paise" : "amount must be a non-negative integer number of paise");
  return BigInt(s);
}

/** Marketplace commission: the fee is rounded DOWN, so any remainder stays with the seller (plan decision 4). */
export function commissionSplit(net: Paise, bps: number): { fee: Paise; seller: Paise } {
  assertPaise(net, "net");
  assertBps(bps, "bps", 10_000);
  const fee = (net * BigInt(bps)) / BPS_DENOMINATOR;
  return { fee, seller: net - fee };
}

/** Amount from a gateway payload or API response: an integer number or digit string, 0 <= v <= MAX_SAFE_INTEGER. Anything else throws. */
export function fromGatewayAmount(v: unknown): Paise {
  const invalid = () => new AppError("GATEWAY_AMOUNT_INVALID", 502, "Payment gateway sent an invalid amount");
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw invalid();
    return BigInt(v);
  }
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) {
    const p = BigInt(v);
    if (p > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    return p;
  }
  throw invalid();
}

/** 12345 paise -> "INR 123.45". Integer arithmetic only; negative amounts keep their sign. */
export function formatInr(paise: Paise): string {
  const abs = paise < 0n ? -paise : paise;
  return `${paise < 0n ? "-" : ""}INR ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** 1800 bps -> "18.00%". */
export function formatBps(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}
