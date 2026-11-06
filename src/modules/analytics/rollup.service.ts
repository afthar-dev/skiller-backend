import { Inject, Injectable, Logger } from "@nestjs/common";
import { ACTIVITY_TTL_DAYS, ActivityTracker } from "../../common/activity/activity-tracker";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { addDays, istDateOf, istDayRange } from "../../common/clock/ist";
import type { MetricPoint, MetricsProvider } from "../../common/metrics/metrics-provider";
import { PrismaService } from "../../common/prisma/prisma.service";
import { METRIC_KEYS, metricDef } from "./metric-catalog";

export const METRICS_PROVIDERS = Symbol("METRICS_PROVIDERS");
/** The most days one rebuild may cover. */
export const MAX_REBUILD_DAYS = 31;

/**
 * Builds `daily_metrics` for IST days. Every module's provider is asked for its own numbers (analytics reads no other module's tables); the
 * activity numbers come from the Redis HyperLogLogs. A day is written with INSERT ... ON CONFLICT DO UPDATE, so running it again overwrites the
 * same rows: a re-run never doubles anything. A provider that fails does not stop the others from being written, but the run then fails (so the
 * job is retried); a key no provider returned is never invented.
 */
@Injectable()
export class RollupService {
  private readonly logger = new Logger(RollupService.name);
  private readonly known = new Set(METRIC_KEYS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityTracker,
    @Inject(METRICS_PROVIDERS) private readonly providers: MetricsProvider[],
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The IST day before the one that contains now: what the 03:00 job rolls up. */
  yesterday(): string {
    return addDays(istDateOf(this.clock.now()), -1);
  }

  /** Rolls one IST day up. Returns the number of keys written. */
  async rollupDay(day: string): Promise<number> {
    istDayRange(day); // throws RangeError for anything that is not a calendar day
    const points: MetricPoint[] = [];
    const failures: string[] = [];
    for (const provider of this.providers) {
      try {
        points.push(...(await provider.collect(day)));
      } catch (err) {
        failures.push(provider.module);
        this.logger.error(`metrics for ${day} from ${provider.module} failed: ${(err as Error).message}`);
      }
    }
    points.push(...(await this.activityPoints(day)));

    const unknown = points.filter((p) => !this.known.has(p.key));
    if (unknown.length > 0) this.logger.warn(`ignoring metrics that are not in the catalog: ${unknown.map((p) => p.key).join(", ")}`);
    // Levels (active subscribers, active gigs) are what they are right now: written for yesterday, never pushed into an older day by a rebuild.
    const recent = day >= this.yesterday();
    const accepted = points.filter((p) => this.known.has(p.key) && (recent || !metricDef(p.key)?.snapshot));
    if (accepted.length > 0) {
      await this.prisma.$executeRaw`
        INSERT INTO "daily_metrics" ("day", "key", "value", "updatedAt")
        SELECT ${day}, t.k, t.v::bigint, now() FROM unnest(${accepted.map((p) => p.key)}::text[], ${accepted.map((p) => p.value.toString())}::text[]) AS t(k, v)
        ON CONFLICT ("day", "key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`;
    }
    if (failures.length > 0) throw new Error(`rollup of ${day} is incomplete: ${failures.join(", ")} failed`);
    return accepted.length;
  }

  /** Every day from `from` to `to` (inclusive), one after the other. */
  async rebuild(from: string, to: string): Promise<{ days: number }> {
    let days = 0;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      await this.rollupDay(day);
      days += 1;
    }
    return { days };
  }

  /**
   * DAU / WAU / MAU for `day` from the HyperLogLogs. A day whose own set is gone yields nothing, so a rebuild of an old day keeps the numbers it had
   * instead of overwriting them with zero. WAU and MAU merge several days' sets and are written only when none of those sets is *lost*: a smaller number
   * from a partial window would replace a correct one. A day without a set is lost when its set has outlived the lifetime of the keys, or when that day
   * was rolled up before (it has a stored `dau`); a day nobody ever tracked (before the platform started) is just empty.
   */
  private async activityPoints(day: string): Promise<MetricPoint[]> {
    const dau = await this.activity.daily(day);
    if (dau === null) return [];
    const points: MetricPoint[] = [{ key: "dau", value: BigInt(dau) }];
    for (const [key, days] of [["wau", 7], ["mau", 30]] as const) {
      const window = await this.activity.window(day, days);
      if (window.count === null || (await this.hasLostDays(window.missing))) {
        this.logger.warn(`${key} for ${day} not written: the activity of ${window.missing.length} day(s) in its window is gone; the stored value stays`);
        continue;
      }
      points.push({ key, value: BigInt(window.count) });
    }
    return points;
  }

  private async hasLostDays(missing: string[]): Promise<boolean> {
    if (missing.length === 0) return false;
    const horizon = addDays(istDateOf(this.clock.now()), -ACTIVITY_TTL_DAYS);
    if (missing.some((d) => d < horizon)) return true;
    return (await this.prisma.dailyMetric.count({ where: { key: "dau", day: { in: missing } } })) > 0;
  }
}
