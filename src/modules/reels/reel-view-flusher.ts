import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis";

/** Counts waiting to be written: one hash, fields `<reelId>:<istDay>:v` (views) and `<reelId>:<istDay>:w` (watched seconds), `<reelId>:<istDay>:c` (course-link clicks). */
export const PENDING_VIEWS_KEY = "reelviews:pending";
/** A batch being applied: the pending hash, renamed. Its id is `<epoch ms>-<uuid>`, so its age is readable from the key. */
export const FLUSHING_VIEWS_PREFIX = "reelviews:flushing:";
/** HyperLogLog of the viewers whose view was counted, per reel per IST day. */
export const viewersKey = (reelId: string, day: string) => `reelviewers:${reelId}:${day}`;

/** A batch older than this is taken to have been abandoned by a crashed run and is applied again (safe: see apply). */
export const STALE_BATCH_MS = 5 * 60 * 1000;
const FIELD = /^([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2}):([vwc])$/;
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const;

interface DailyTotals {
  reelId: string;
  day: string;
  views: number;
  watchSec: number;
  clicks: number;
}

/**
 * Moves the view counts from Redis to Postgres. RENAME is atomic, so every count is in exactly one hash: the one new views are written to, or
 * a batch that is being applied. A batch is applied in one transaction that also records its id (ReelViewFlush); if the run dies after the
 * commit but before the key is deleted, the next run finds the id recorded and only deletes the key. If it dies before the commit, the key
 * is still there and is applied by the recovery step once it is stale. So each batch is applied exactly once and none is lost.
 */
@Injectable()
export class ReelViewFlusher {
  private readonly logger = new Logger(ReelViewFlusher.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One run: recover abandoned batches, then take whatever is pending. Throws if a batch cannot be applied (it stays in Redis). */
  async flush(): Promise<{ batches: number }> {
    let batches = 0;
    for (const key of await this.staleBatches()) if (await this.apply(key)) batches++;

    const key = `${FLUSHING_VIEWS_PREFIX}${this.clock.now().getTime()}-${randomUUID()}`;
    try {
      await this.redis.rename(PENDING_VIEWS_KEY, key);
    } catch (err) {
      if (/no such key/i.test((err as Error).message)) return { batches };
      throw err;
    }
    if (await this.apply(key)) batches++;
    return { batches };
  }

  private async staleBatches(): Promise<string[]> {
    const cutoff = this.clock.now().getTime() - STALE_BATCH_MS;
    const stale: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${FLUSHING_VIEWS_PREFIX}*`, "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        const at = Number(key.slice(FLUSHING_VIEWS_PREFIX.length).split("-")[0]);
        if (!Number.isFinite(at) || at <= cutoff) stale.push(key);
      }
    } while (cursor !== "0");
    return stale;
  }

  /** Applies one batch and deletes its key. Returns false when the key was already gone (another run finished it). */
  private async apply(key: string): Promise<boolean> {
    const raw = await this.redis.hgetall(key);
    if (Object.keys(raw).length === 0) {
      await this.redis.del(key);
      return false;
    }
    const totals = new Map<string, DailyTotals>();
    for (const [field, value] of Object.entries(raw)) {
      const m = FIELD.exec(field);
      const n = Number.parseInt(value, 10);
      if (!m || !Number.isFinite(n) || n < 0) continue;
      const id = `${m[1]}:${m[2]}`;
      const entry = totals.get(id) ?? { reelId: m[1], day: m[2], views: 0, watchSec: 0, clicks: 0 };
      if (m[3] === "v") entry.views += n;
      else if (m[3] === "w") entry.watchSec += n;
      else entry.clicks += n;
      totals.set(id, entry);
    }
    const days = [...totals.values()].sort((a, b) => (a.reelId === b.reelId ? a.day.localeCompare(b.day) : a.reelId.localeCompare(b.reelId)));

    // Approximate unique viewers: the HyperLogLog's count so far (an absolute number, so applying it twice is harmless).
    const pipeline = this.redis.pipeline();
    for (const d of days) pipeline.pfcount(viewersKey(d.reelId, d.day));
    const counted = (await pipeline.exec()) ?? [];
    const unique = days.map((_, i) => Number(counted[i]?.[1] ?? 0));

    const batchId = key.slice(FLUSHING_VIEWS_PREFIX.length);
    const now = this.clock.now();
    const applied = await this.prisma.$transaction(async (tx) => {
      const recorded = await tx.$executeRaw`INSERT INTO "reel_view_flushes" ("id", "appliedAt") VALUES (${batchId}, ${now}) ON CONFLICT ("id") DO NOTHING`;
      if (recorded === 0) return false; // applied before; only the key is left over
      const reelIds = days.map((d) => d.reelId);
      const dayNames = days.map((d) => d.day);
      const views = days.map((d) => d.views);
      const watch = days.map((d) => d.watchSec);
      const clicks = days.map((d) => d.clicks);
      // Counts for a reel that no longer exists drop out of both joins.
      await tx.$executeRaw`
        UPDATE "reels" r SET "viewCount" = r."viewCount" + x."views", "watchSecTotal" = r."watchSecTotal" + x."watchSec"
        FROM (
          SELECT "reelId", SUM("views")::int AS "views", SUM("watchSec")::int AS "watchSec"
          FROM unnest(${reelIds}::text[], ${views}::int[], ${watch}::int[]) AS t("reelId", "views", "watchSec")
          GROUP BY "reelId" ORDER BY "reelId"
        ) x
        WHERE r."id" = x."reelId"`;
      await tx.$executeRaw`
        INSERT INTO "reel_view_daily" ("reelId", "day", "views", "watchSec", "uniqueViewers", "linkClicks", "updatedAt")
        SELECT t."reelId", t."day", t."views", t."watchSec", t."unique", t."clicks", ${now}
        FROM unnest(${reelIds}::text[], ${dayNames}::text[], ${views}::int[], ${watch}::int[], ${unique}::int[], ${clicks}::int[]) AS t("reelId", "day", "views", "watchSec", "unique", "clicks")
        JOIN "reels" r ON r."id" = t."reelId"
        ON CONFLICT ("reelId", "day") DO UPDATE SET
          "views" = "reel_view_daily"."views" + EXCLUDED."views",
          "watchSec" = "reel_view_daily"."watchSec" + EXCLUDED."watchSec",
          "linkClicks" = "reel_view_daily"."linkClicks" + EXCLUDED."linkClicks",
          "uniqueViewers" = GREATEST("reel_view_daily"."uniqueViewers", EXCLUDED."uniqueViewers"),
          "updatedAt" = EXCLUDED."updatedAt"`;
      return true;
    }, TX_OPTIONS);
    await this.redis.del(key);
    if (applied) this.logger.debug(`applied view batch ${batchId}: ${days.length} reel-day(s)`);
    return applied;
  }
}
