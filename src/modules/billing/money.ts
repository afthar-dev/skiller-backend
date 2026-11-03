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
