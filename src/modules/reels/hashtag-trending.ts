import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis";

export const TRENDING_KEY = "reels:trending-hashtags";
export const TRENDING_SIZE = 20;
const WINDOW_MS = 24 * 3600_000;
/** What the hourly job stores outlives the next run by an hour, so one missed run does not blank the list. */
export const TRENDING_JOB_TTL_SEC = 2 * 3600;
/** A list computed on demand (no job has run yet, or Redis was flushed) is reused this long. */
export const TRENDING_ON_DEMAND_TTL_SEC = 5 * 60;

export interface TrendingHashtag {
  tag: string;
  /** Published reels that used the tag in the last 24 hours. */
  uses: number;
  /** The same for the 24 hours before that. */
  previousUses: number;
}

export interface TrendingList {
  computedAt: string;
  items: TrendingHashtag[];
}

/**
 * Trending hashtags: the 20 tags whose use in the last 24 h grew the most over the 24 h before (uses now minus uses then; more uses now
 * break ties). A "use" is a reel published in the window that carries the tag and is still published. Computed hourly by a job into Redis;
 * requests only read the stored list, and compute it once if there is none.
 */
@Injectable()
export class HashtagTrending {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The hourly job: recompute and store. */
  async refresh(ttlSec = TRENDING_JOB_TTL_SEC): Promise<TrendingList> {
    const list = await this.compute();
    await this.redis.set(TRENDING_KEY, JSON.stringify(list), "EX", ttlSec);
    return list;
  }

  async current(): Promise<TrendingList> {
    const cached = await this.redis.get(TRENDING_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as TrendingList;
        if (Array.isArray(parsed.items)) return parsed;
      } catch {
        // recompute below
      }
    }
    return this.refresh(TRENDING_ON_DEMAND_TTL_SEC);
  }

  private async compute(): Promise<TrendingList> {
    const now = this.clock.now();
    const cut = new Date(now.getTime() - WINDOW_MS);
    const from = new Date(now.getTime() - 2 * WINDOW_MS);
    const rows = await this.prisma.$queryRaw<Array<{ tag: string; uses: bigint; previous: bigint }>>`
      SELECT t."tag", count(*) FILTER (WHERE r."publishedAt" >= ${cut}) AS "uses", count(*) FILTER (WHERE r."publishedAt" < ${cut}) AS "previous"
      FROM "reels" r, unnest(r."hashtags") AS t("tag")
      WHERE r."status" = 'PUBLISHED'::"ReelStatus" AND r."publishedAt" >= ${from} AND r."publishedAt" <= ${now}
      GROUP BY t."tag"
      HAVING count(*) FILTER (WHERE r."publishedAt" >= ${cut}) > 0
      ORDER BY (count(*) FILTER (WHERE r."publishedAt" >= ${cut}) - count(*) FILTER (WHERE r."publishedAt" < ${cut})) DESC,
               count(*) FILTER (WHERE r."publishedAt" >= ${cut}) DESC, t."tag" ASC
      LIMIT ${TRENDING_SIZE}`;
    return { computedAt: now.toISOString(), items: rows.map((r) => ({ tag: r.tag, uses: Number(r.uses), previousUses: Number(r.previous) })) };
  }
}
