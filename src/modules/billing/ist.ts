/** India has no daylight saving, so an IST day is a fixed +05:30 offset from UTC. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" of the IST calendar day containing the instant. */
export function istDateOf(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of an IST calendar day as UTC instants. Throws for anything that is not a real calendar date. */
export function istDayRange(date: string): { from: Date; to: Date } {
  const utcMidnight = DATE_PATTERN.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  if (Number.isNaN(utcMidnight) || new Date(utcMidnight).toISOString().slice(0, 10) !== date) throw new RangeError(`not a calendar date: ${date}`);
  const from = new Date(utcMidnight - IST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The IST day before the one containing `now`: what the 02:00 IST job reconciles. */
export const previousIstDay = (now: Date): string => addDays(istDateOf(now), -1);

/** Inclusive IST day range ("from" .. "to") as a half-open UTC window for a Prisma `createdAt`-style filter; either end may be omitted. */
export function istWindow(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: istDayRange(from).from } : {}), ...(to ? { lt: istDayRange(to).to } : {}) };
}
