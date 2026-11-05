import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { addDays, EntitlementsService, istDateOf, istDayRange } from "../billing";
import { MediaAttachments } from "../media";
import { FollowsService } from "../users";
import { reelNotFound } from "./reel-rules";

export const REEL_ANALYTICS_MAX_DAYS = 366;
export const REEL_ANALYTICS_DEFAULT_DAYS = 30;
/** Used when a video has no recorded duration (the view tracker caps watch time at the same value). */
const FALLBACK_DURATION_SEC = 90;
const TOP_REELS = 10;
const DAY_MS = 86_400_000;

const badRange = (message: string) => new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { range: [message] } });

export interface ReelAnalyticsRange {
  /** Inclusive IST calendar days. */
  from: string;
  to: string;
}

export interface ReelTotals {
  views: number;
  /** Approximate: each reel's per-day viewer count (a HyperLogLog), summed, so someone who watches on two days counts twice. */
  uniqueViewers: number;
  watchSec: number;
  /** Watch seconds over the seconds viewers could have watched (views x video length), 0..100, one decimal. */
  avgWatchPct: number;
  linkClicks: number;
  /** New followers of the creator in the range. Not attributed to any reel. */
  newFollowers: number;
}

export interface ReelDailyPoint {
  date: string;
  views: number;
  watchSec: number;
  linkClicks: number;
}

export interface ReelLiveCounts {
  likes: number;
  comments: number;
  saves: number;
  shares: number;
}

export interface ReelAnalytics {
  range: ReelAnalyticsRange;
  totals: ReelTotals;
  /** Current counters (not limited to the range). */
  live: ReelLiveCounts;
  /** False on standard / advanced plans, true when the plan only gets totals. */
  upgradeRequired: boolean;
  daily?: ReelDailyPoint[];
}

export interface CreatorReelAnalytics extends ReelAnalytics {
  topReels?: Array<{ reelId: string; caption: string; status: string; views: number; uniqueViewers: number; avgWatchPct: number; linkClicks: number } & ReelLiveCounts>;
}

export interface SingleReelAnalytics extends ReelAnalytics {
  reelId: string;
  /** Followers are the creator's: `totals.newFollowers` is not attributed to this reel. */
  newFollowersScope: "creator";
}

interface PerReelRow {
  reelId: string;
  views: number;
  watchSec: number;
  uniqueViewers: number;
  linkClicks: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Creator analytics for reels. Views, watch time, unique viewers and link clicks come from the per-IST-day rows the view flush writes
 * (`ReelViewDaily`), so they lag the live counters by up to a flush interval; likes, comments, saves and shares are the live counters.
 * Everything is aggregated in SQL. Plans with `analytics_level` basic get totals only.
 */
@Injectable()
export class ReelAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly media: MediaAttachments,
    private readonly follows: FollowsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async forCreator(userId: string, query: { from?: string; to?: string }): Promise<CreatorReelAnalytics> {
    const range = this.range(query);
    const detailed = await this.detailed(userId);
    const [rows, newFollowers, live] = await Promise.all([
      this.prisma.$queryRaw<PerReelRow[]>`
        SELECT d."reelId", SUM(d."views")::int AS "views", SUM(d."watchSec")::int AS "watchSec", SUM(d."uniqueViewers")::int AS "uniqueViewers", SUM(d."linkClicks")::int AS "linkClicks"
        FROM "reel_view_daily" d JOIN "reels" r ON r."id" = d."reelId"
        WHERE r."creatorId" = ${userId} AND d."day" >= ${range.from} AND d."day" <= ${range.to}
        GROUP BY d."reelId"`,
      this.follows.newFollowers(userId, istDayRange(range.from).from, istDayRange(range.to).to),
      this.prisma.reel.aggregate({ where: { creatorId: userId, status: "PUBLISHED" }, _sum: { likeCount: true, commentCount: true, saveCount: true, shareCount: true } }),
    ]);
    const reels = rows.length ? await this.prisma.reel.findMany({ where: { id: { in: rows.map((r) => r.reelId) } }, select: { id: true, caption: true, status: true, mediaAssetId: true, likeCount: true, commentCount: true, saveCount: true, shareCount: true } }) : [];
    const durations = await this.media.durations(reels.map((r) => r.mediaAssetId));
    const byId = new Map(reels.map((r) => [r.id, r]));
    const durationOf = (reelId: string) => durations.get(byId.get(reelId)?.mediaAssetId ?? "") || FALLBACK_DURATION_SEC;

    const result: CreatorReelAnalytics = {
      range,
      totals: { ...this.sum(rows, durationOf), newFollowers },
      live: { likes: live._sum.likeCount ?? 0, comments: live._sum.commentCount ?? 0, saves: live._sum.saveCount ?? 0, shares: live._sum.shareCount ?? 0 },
      upgradeRequired: !detailed,
    };
    if (detailed) {
      result.daily = await this.daily(range, { creatorId: userId });
      result.topReels = rows
        .filter((r) => r.views > 0 && byId.get(r.reelId) && byId.get(r.reelId)!.status !== "DELETED")
        .sort((a, b) => b.views - a.views || (a.reelId < b.reelId ? 1 : -1))
        .slice(0, TOP_REELS)
        .map((r) => {
          const reel = byId.get(r.reelId)!;
          return {
            reelId: r.reelId,
            caption: reel.caption,
            status: reel.status,
            views: r.views,
            uniqueViewers: r.uniqueViewers,
            avgWatchPct: this.watchPct(r.watchSec, r.views * durationOf(r.reelId)),
            linkClicks: r.linkClicks,
            likes: reel.likeCount,
            comments: reel.commentCount,
            saves: reel.saveCount,
            shares: reel.shareCount,
          };
        });
    }
    return result;
  }

  async forReel(userId: string, reelId: string, query: { from?: string; to?: string }): Promise<SingleReelAnalytics> {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || reel.creatorId !== userId || reel.status === "DELETED") throw reelNotFound();
    const range = this.range(query);
    const detailed = await this.detailed(userId);
    const [rows, newFollowers, duration] = await Promise.all([
      this.prisma.$queryRaw<PerReelRow[]>`
        SELECT d."reelId", SUM(d."views")::int AS "views", SUM(d."watchSec")::int AS "watchSec", SUM(d."uniqueViewers")::int AS "uniqueViewers", SUM(d."linkClicks")::int AS "linkClicks"
        FROM "reel_view_daily" d WHERE d."reelId" = ${reelId} AND d."day" >= ${range.from} AND d."day" <= ${range.to}
        GROUP BY d."reelId"`,
      this.follows.newFollowers(userId, istDayRange(range.from).from, istDayRange(range.to).to),
      this.media.durations([reel.mediaAssetId]),
    ]);
    const seconds = duration.get(reel.mediaAssetId) || FALLBACK_DURATION_SEC;
    const result: SingleReelAnalytics = {
      reelId,
      range,
      totals: { ...this.sum(rows, () => seconds), newFollowers },
      newFollowersScope: "creator",
      live: { likes: reel.likeCount, comments: reel.commentCount, saves: reel.saveCount, shares: reel.shareCount },
      upgradeRequired: !detailed,
    };
    if (detailed) result.daily = await this.daily(range, { reelId });
    return result;
  }

  private async detailed(userId: string): Promise<boolean> {
    const level = await this.entitlements.limit({ ownerType: "USER", ownerId: userId }, "analytics_level");
    return level === "standard" || level === "advanced";
  }

  private sum(rows: PerReelRow[], durationOf: (reelId: string) => number): Omit<ReelTotals, "newFollowers"> {
    let views = 0;
    let watchSec = 0;
    let uniqueViewers = 0;
    let linkClicks = 0;
    let available = 0;
    for (const r of rows) {
      views += r.views;
      watchSec += r.watchSec;
      uniqueViewers += r.uniqueViewers;
      linkClicks += r.linkClicks;
      available += r.views * durationOf(r.reelId);
    }
    return { views, uniqueViewers, watchSec, avgWatchPct: this.watchPct(watchSec, available), linkClicks };
  }

  private watchPct(watchSec: number, availableSec: number): number {
    return availableSec > 0 ? Math.min(100, round1((watchSec / availableSec) * 100)) : 0;
  }

  /** One point per IST day of the range, zeros for days without data. */
  private async daily(range: ReelAnalyticsRange, scope: { creatorId: string } | { reelId: string }): Promise<ReelDailyPoint[]> {
    const rows =
      "creatorId" in scope
        ? await this.prisma.$queryRaw<{ day: string; views: number; watchSec: number; linkClicks: number }[]>`
            SELECT d."day", SUM(d."views")::int AS "views", SUM(d."watchSec")::int AS "watchSec", SUM(d."linkClicks")::int AS "linkClicks"
            FROM "reel_view_daily" d JOIN "reels" r ON r."id" = d."reelId"
            WHERE r."creatorId" = ${scope.creatorId} AND d."day" >= ${range.from} AND d."day" <= ${range.to}
            GROUP BY d."day"`
        : await this.prisma.$queryRaw<{ day: string; views: number; watchSec: number; linkClicks: number }[]>`
            SELECT d."day", d."views", d."watchSec", d."linkClicks"
            FROM "reel_view_daily" d WHERE d."reelId" = ${scope.reelId} AND d."day" >= ${range.from} AND d."day" <= ${range.to}`;
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out: ReelDailyPoint[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      const r = byDay.get(d);
      out.push({ date: d, views: r?.views ?? 0, watchSec: r?.watchSec ?? 0, linkClicks: r?.linkClicks ?? 0 });
    }
    return out;
  }

  private range(query: { from?: string; to?: string }): ReelAnalyticsRange {
    const to = query.to ?? istDateOf(this.clock.now());
    const from = query.from ?? addDays(to, -(REEL_ANALYTICS_DEFAULT_DAYS - 1));
    let days: number;
    try {
      days = Math.round((istDayRange(to).from.getTime() - istDayRange(from).from.getTime()) / DAY_MS) + 1;
    } catch {
      throw badRange("from and to must be real calendar dates (YYYY-MM-DD)");
    }
    if (days < 1) throw badRange("from must not be after to");
    if (days > REEL_ANALYTICS_MAX_DAYS) throw badRange(`the range can cover at most ${REEL_ANALYTICS_MAX_DAYS} days`);
    return { from, to };
  }
}
