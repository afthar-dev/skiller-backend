import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { addDays, DATE_PATTERN, istDateOf, istDayRange } from "../../common/clock/ist";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { FUNNEL_STAGES, METRIC_CATALOG, METRIC_KEYS, metricDef, type MetricDef } from "./metric-catalog";
import { MAX_REBUILD_DAYS } from "./rollup.service";

/** Ranges are limited to two years of days. */
export const MAX_RANGE_DAYS = 731;
const MAX_KEYS = 40;
const DEFAULT_DAYS = 30;

export interface DayRange {
  from: string;
  to: string;
}

/** Counts are JSON numbers; money is a decimal string of paise (amounts can exceed 2^53). */
export type MetricValue = number | string;

const invalidRange = (message: string) => new AppError("ANALYTICS_RANGE_INVALID", 400, message);
const present = (v: string | undefined): v is string => v !== undefined && v !== "";

function isCalendarDay(day: string): boolean {
  if (!DATE_PATTERN.test(day)) return false;
  try {
    istDayRange(day);
    return true;
  } catch {
    return false;
  }
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** The IST days a dashboard shows. Numbers come from the daily rollup only (`daily_metrics`); this class never reads another module's tables. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `from` / `to` are IST days, both inclusive. Default: the 30 days ending today. At most two years. */
  range(from?: string, to?: string): DayRange {
    const end = present(to) ? to : istDateOf(this.clock.now());
    if (!isCalendarDay(end) || (present(from) && !isCalendarDay(from))) throw invalidRange("from and to must be calendar days, YYYY-MM-DD (India time)");
    const start = present(from) ? from : addDays(end, -(DEFAULT_DAYS - 1));
    if (start > end) throw invalidRange("from must not be after to");
    if (daysBetween(start, end) > MAX_RANGE_DAYS) throw invalidRange("The range is limited to 2 years (731 days)");
    return { from: start, to: end };
  }

  /** A rebuild covers past days only (today is not over), at most 31 of them. */
  rebuildRange(from: string, to: string): DayRange {
    if (!isCalendarDay(from) || !isCalendarDay(to)) throw invalidRange("from and to must be calendar days, YYYY-MM-DD (India time)");
    if (from > to) throw invalidRange("from must not be after to");
    if (to >= istDateOf(this.clock.now())) throw invalidRange("Only days that are over can be rebuilt: to must be before today");
    if (daysBetween(from, to) > MAX_REBUILD_DAYS) throw new AppError("ANALYTICS_RANGE_INVALID", 400, `A rebuild covers at most ${MAX_REBUILD_DAYS} days`);
    return { from, to };
  }

  /** Comma-separated metric keys; unknown keys are refused. */
  keys(raw: string | undefined): string[] {
    const list = (raw ?? "").split(",").map((k) => k.trim()).filter((k) => k !== "");
    if (list.length === 0) throw new AppError("VALIDATION_FAILED", 400, "keys is required: a comma-separated list of metric keys", { fields: ["keys"] });
    const unique = [...new Set(list)];
    const unknown = unique.filter((k) => !METRIC_KEYS.includes(k));
    if (unknown.length > 0 || unique.length > MAX_KEYS) throw new AppError("ANALYTICS_UNKNOWN_METRIC", 400, "Unknown metric key", { unknown, known: METRIC_KEYS });
    return unique;
  }

  private async load(keys: readonly string[], range: DayRange) {
    return this.prisma.dailyMetric.findMany({ where: { key: { in: [...keys] }, day: { gte: range.from, lte: range.to } }, orderBy: [{ day: "asc" }, { key: "asc" }] });
  }

  private format(def: MetricDef, value: bigint): MetricValue {
    return def.unit === "paise" ? value.toString() : Number(value);
  }

  /** The newest day in the range that has been rolled up (any metric), so a reader can tell whether the last days are still missing. */
  private async dataThrough(range: DayRange): Promise<string | null> {
    const row = await this.prisma.dailyMetric.findFirst({ where: { day: { gte: range.from, lte: range.to } }, orderBy: { day: "desc" }, select: { day: true } });
    return row?.day ?? null;
  }

  /** Every metric for the range: summed over the days, or the last day's value for levels and distinct counts. */
  async overview(range: DayRange) {
    const rows = await this.load(METRIC_KEYS, range);
    const metrics = METRIC_CATALOG.map((def) => {
      const own = rows.filter((r) => r.key === def.key);
      let total = 0n;
      let asOf: string | null = null;
      if (def.aggregation === "sum") {
        for (const r of own) total += r.value;
      } else if (own.length > 0) {
        const last = own[own.length - 1];
        total = last.value;
        asOf = last.day;
      }
      return { key: def.key, label: def.label, group: def.group, unit: def.unit, aggregation: def.aggregation, approximate: def.approximate ?? false, value: this.format(def, total), asOf };
    });
    return { from: range.from, to: range.to, days: daysBetween(range.from, range.to), dataThrough: await this.dataThrough(range), metrics };
  }

  /** One row per day in the range (a day with no rollup shows 0), for the chosen keys. */
  async series(keys: string[], range: DayRange) {
    const rows = await this.load(keys, range);
    const byDay = new Map<string, Map<string, bigint>>();
    for (const r of rows) {
      const m = byDay.get(r.day) ?? new Map<string, bigint>();
      m.set(r.key, r.value);
      byDay.set(r.day, m);
    }
    const points: Array<{ day: string; values: Record<string, MetricValue> }> = [];
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
      const values: Record<string, MetricValue> = {};
      for (const key of keys) values[key] = this.format(metricDef(key)!, byDay.get(day)?.get(key) ?? 0n);
      points.push({ day, values });
    }
    return {
      from: range.from,
      to: range.to,
      keys: keys.map((k) => ({ key: k, label: metricDef(k)!.label, unit: metricDef(k)!.unit, approximate: metricDef(k)!.approximate ?? false })),
      dataThrough: await this.dataThrough(range),
      points,
    };
  }

  /** Signup -> creator -> first published course or gig -> first sale, as counts for the range. Not a cohort: stages count different members, and nobody is identified. */
  async funnel(range: DayRange) {
    const keys = [...new Set(FUNNEL_STAGES.flatMap((s) => s.from))];
    const rows = await this.load(keys, range);
    const total = (key: string) => rows.filter((r) => r.key === key).reduce((sum, r) => sum + r.value, 0n);
    return {
      from: range.from,
      to: range.to,
      dataThrough: await this.dataThrough(range),
      note: "Counts of events in the range, not a cohort: each stage counts the members who reached it in these days, whenever they signed up. A seller who publishes both a first course and a first gig on different days counts at that stage twice.",
      stages: FUNNEL_STAGES.map((s) => ({ key: s.key, label: s.label, count: Number(s.from.reduce((sum, k) => sum + total(k), 0n)) })),
    };
  }

  /** The series as CSV text. Money stays in paise (the column name says so). Text cells are guarded against spreadsheet formulas. */
  async csv(keys: string[], range: DayRange): Promise<{ filename: string; body: string }> {
    const { points } = await this.series(keys, range);
    const lines = [["day", ...keys].map(csvText).join(",")];
    for (const p of points) lines.push([csvText(p.day), ...keys.map((k) => csvNumber(p.values[k]))].join(","));
    return { filename: `skiller-analytics-${range.from}_${range.to}.csv`, body: `${lines.join("\r\n")}\r\n` };
  }
}

/**
 * Text cells: quoted when they hold a comma, quote or line break, and prefixed with an apostrophe when they start with a character a spreadsheet
 * would read as a formula (= + - @ tab, carriage return), so nothing written into a cell can run when an admin opens the file.
 */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Numbers are written as they are (a negative amount starts with "-" and must stay a number); anything that is not plain digits is treated as text. */
function csvNumber(value: MetricValue | undefined): string {
  const text = String(value ?? 0);
  return /^-?\d+$/.test(text) ? text : csvText(text);
}
