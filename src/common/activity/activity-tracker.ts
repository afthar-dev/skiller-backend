import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../clock/clock";
import { addDays, istDateOf } from "../clock/ist";
import { REDIS } from "../redis/redis.constants";

/**
 * Daily sets live this long: a 30-day window ending on the oldest day a rebuild may cover (31 days back) still has every set (30 + 31 = 61, plus one),
 * so a rebuild recomputes WAU / MAU instead of leaving them out.
 */
export const ACTIVITY_TTL_DAYS = 62;
export const ACTIVITY_TTL_SECONDS = ACTIVITY_TTL_DAYS * 24 * 3600;
const SEEN_CAP = 100_000;

export const activityKey = (day: string) => `activity:hll:${day}`;

/**
 * Who was active on which IST day, as one Redis HyperLogLog per day (PFADD): about 12 KB per day however many members, no per-user rows and
 * no user list anywhere. Counts are approximate (standard error about 0.81%); that is fine for DAU / WAU / MAU and is documented as such.
 * WAU / MAU are the PFMERGE of the last 7 / 30 day sets, so a member active on several days counts once. The keys expire after 62 days.
 * Recording is fire-and-forget and swallows every error: tracking can never fail or slow a request. Each process remembers whom it already
 * added today, so a busy member costs one Redis call a day per process rather than one per request.
 */
@Injectable()
export class ActivityTracker {
  private readonly logger = new Logger(ActivityTracker.name);
  private seenDay = "";
  private seen = new Set<string>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Never throws and never waits for Redis. */
  record(userId: string): void {
    try {
      const day = istDateOf(this.clock.now());
      if (day !== this.seenDay) {
        this.seenDay = day;
        this.seen = new Set();
      }
      if (this.seen.has(userId)) return;
      if (this.seen.size >= SEEN_CAP) this.seen.clear();
      this.seen.add(userId);
      const key = activityKey(day);
      void this.redis
        .multi()
        .pfadd(key, userId)
        .expire(key, ACTIVITY_TTL_SECONDS)
        .exec()
        .catch((err: Error) => {
          this.seen.delete(userId);
          this.logger.warn(`activity not recorded: ${err.message}`);
        });
    } catch (err) {
      this.logger.warn(`activity not recorded: ${(err as Error).message}`);
    }
  }

  /** Approximate distinct members active on `day`, or null when that day's set is gone (expired or never written). */
  async daily(day: string): Promise<number | null> {
    if ((await this.redis.exists(activityKey(day))) === 0) return null;
    return this.redis.pfcount(activityKey(day));
  }

  /**
   * Approximate distinct members active in the `days` days ending on `endDay` (inclusive), merged from the sets that exist, and the days that have no
   * set (never written, or expired). The caller decides whether a missing day means "nobody was active" or "the data is gone": `count` is null when none
   * of the days has a set.
   */
  async window(endDay: string, days: number): Promise<{ count: number | null; missing: string[] }> {
    const present: string[] = [];
    const missing: string[] = [];
    for (let i = 0; i < days; i++) {
      const day = addDays(endDay, -i);
      if ((await this.redis.exists(activityKey(day))) === 1) present.push(activityKey(day));
      else missing.push(day);
    }
    if (present.length === 0) return { count: null, missing };
    const tmp = `activity:tmp:${endDay}:${days}:${process.pid}:${Date.now()}`;
    try {
      await this.redis.pfmerge(tmp, ...present);
      return { count: await this.redis.pfcount(tmp), missing };
    } finally {
      await this.redis.del(tmp).catch(() => undefined);
    }
  }
}
