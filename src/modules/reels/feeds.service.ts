import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Reel } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import type { PageQuery } from "../../common/http/pagination";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { CourseCategories } from "../courses";
import { FollowsService } from "../users";
import { interleave, normaliseInterests, rankReels, type FeedReel } from "./feed-ranking";
import { InterestsService } from "./interests.service";
import { ReelVisibility } from "./reel-visibility";
import { ReelViews, type ReelView } from "./reel-views";
import { collectVisible } from "./visible-page";

export const FEED_REQUESTS_PER_MINUTE = 120;
/** A signed-in viewer's ranked list is kept this long (and kept alive while they keep scrolling). */
export const FOR_YOU_SESSION_TTL_SEC = 30 * 60;
/** Signed-out viewers share one ranking, rebuilt at most this often. */
export const FOR_YOU_GLOBAL_TTL_SEC = 5 * 60;
export const FOR_YOU_GLOBAL_KEY = "foryou-global";
/** One key per signed-in viewer (a fresh first page overwrites it): memory is bounded by the active viewers, not by the requests. */
export const forYouUserKey = (userId: string) => `foryou:u:${userId}`;
/** A stored list holds at most this many reel ids (about 11 KB). */
export const FOR_YOU_MAX_IDS = 300;

const RECENT_DAYS = 7;
const FILL_DAYS = 30;
/** Candidates: the newest RECENT_TAKE and the most engaging ENGAGING_TAKE of the last 7 days (de-duplicated); below MIN_CANDIDATES the best of the last 30 days fill the gap. */
const RECENT_TAKE = 300;
const ENGAGING_TAKE = 300;
const MIN_CANDIDATES = 100;
const DAY_MS = 24 * 3600_000;
const FOLLOWING_CURSOR = "feed-following";
const FOR_YOU_CURSOR = "feed-for-you";
/** Reels looked at per visibility check when a For you page is filled from its snapshot. */
const SNAPSHOT_CHUNK = 25;

export interface FeedPage {
  items: ReelView[];
  nextCursor: string | null;
}

/** A signed-in viewer's list: `g` is its generation, carried by every cursor, so a cursor from before a fresh first page is recognised as stale. */
interface Session {
  g: string;
  ids: string[];
}

/** The shared signed-out ranking (not yet spread over blocks: each cursor carries its own block size). */
interface GlobalList {
  g: string;
  ranked: Array<{ id: string; creatorId: string }>;
}

const ENGAGEMENT_RATE_SQL = Prisma.sql`("likeCount" + 2 * "commentCount" + 3 * "saveCount" + 2 * "shareCount")::float8 / GREATEST("viewCount", 20)`;

const CANDIDATE_SELECT = {
  id: true,
  creatorId: true,
  publishedAt: true,
  likeCount: true,
  commentCount: true,
  saveCount: true,
  shareCount: true,
  viewCount: true,
  hashtags: true,
  linkedCourseId: true,
} as const;
type CandidateRow = Prisma.ReelGetPayload<{ select: typeof CANDIDATE_SELECT }>;

@Injectable()
export class FeedsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: ReelViews,
    private readonly visibility: ReelVisibility,
    private readonly follows: FollowsService,
    private readonly interests: InterestsService,
    private readonly categories: CourseCategories,
    private readonly cursors: SignedCursor,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Published reels of the creators the viewer follows, newest first, keyset-paged on (publishedAt, id). */
  async following(userId: string, page: PageQuery): Promise<FeedPage> {
    await consumeRateLimit(this.redis, `feed:${userId}`, FEED_REQUESTS_PER_MINUTE, 60);
    type Pos = { t: Date; id: string };
    let start: Pos | null = null;
    if (page.cursor) {
      const c = this.cursors.verify(FOLLOWING_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      start = { t, id: c.id };
    }
    const creatorIds = await this.visibility.filterVisible(userId, { creatorIds: await this.follows.followeeIds(userId) });
    if (creatorIds.length === 0) return { items: [], nextCursor: null };

    const { items, next } = await collectVisible<Reel, Pos>({
      limit: page.limit,
      start,
      fetch: (after, take) =>
        this.prisma.reel.findMany({
          where: {
            creatorId: { in: creatorIds },
            status: "PUBLISHED",
            ...(after ? { OR: [{ publishedAt: { lt: after.t } }, { publishedAt: after.t, id: { lt: after.id } }] } : {}),
          },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          take,
        }),
      posOf: (r) => ({ t: r.publishedAt!, id: r.id }),
      idOf: (r) => r.id,
      visible: (ids) => this.visibility.filterVisible(userId, { reelIds: ids }),
    });
    return { items: await this.views.build(items, userId), nextCursor: next ? this.cursors.sign(FOLLOWING_CURSOR, { t: next.t.toISOString(), id: next.id }) : null };
  }

  /**
   * Personalised (signed out: global) ranking, served from a snapshot. A signed-in viewer's first page ranks the candidates and stores the ordered ids under
   * their own key (overwriting the previous list); a signed-out viewer reads the shared five-minute list, which stores nothing per visitor. Later pages read
   * slices of that list, so new reels and changing counts never reorder, insert into or repeat within a scroll in progress. Each id is checked again when
   * it is served (a reel hidden or deleted since is skipped, and the page is topped up). A cursor from before the list was replaced (a newer first page,
   * expiry, the shared list rebuilt) starts over with a fresh ranking and says so (`refreshed`).
   */
  async forYou(viewerId: string | null, ip: string, page: PageQuery): Promise<FeedPage & { refreshed: boolean }> {
    await consumeRateLimit(this.redis, `feed:${viewerId ?? ip}`, FEED_REQUESTS_PER_MINUTE, 60);
    let refreshed = false;
    let list: { g: string; ids: string[]; offset: number; block: number } | null = null;
    if (page.cursor) {
      const c = this.cursors.verify(FOR_YOU_CURSOR, page.cursor);
      if (typeof c.s !== "string" || typeof c.o !== "number" || !Number.isInteger(c.o) || c.o < 0 || typeof c.b !== "number" || !Number.isInteger(c.b) || c.b < 1 || c.b > 100) throw badCursor();
      if (viewerId) {
        const stored = await this.readSession(viewerId);
        if (stored && stored.g === c.s) {
          await this.redis.expire(forYouUserKey(viewerId), FOR_YOU_SESSION_TTL_SEC);
          list = { g: stored.g, ids: stored.ids, offset: c.o, block: c.b };
        }
      } else {
        const shared = await this.globalList();
        if (shared.g === c.s) list = { g: shared.g, ids: this.spread(shared.ranked, c.b), offset: c.o, block: c.b };
      }
      refreshed = list === null;
    }
    if (!list) list = viewerId ? await this.startSession(viewerId, page.limit) : await this.startShared(page.limit);

    const served: string[] = [];
    let pos = list.offset;
    while (served.length < page.limit && pos < list.ids.length) {
      const chunk = list.ids.slice(pos, pos + Math.max(SNAPSHOT_CHUNK, page.limit - served.length));
      const ok = new Set(await this.visibility.filterVisible(viewerId, { reelIds: chunk }));
      for (const id of chunk) {
        pos++;
        if (ok.has(id)) served.push(id);
        if (served.length === page.limit) break;
      }
    }
    const rows = new Map((await this.prisma.reel.findMany({ where: { id: { in: served }, status: "PUBLISHED" } })).map((r) => [r.id, r]));
    const items = await this.views.build(served.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])), viewerId);
    const nextCursor = pos < list.ids.length ? this.cursors.sign(FOR_YOU_CURSOR, { s: list.g, o: pos, b: list.block }) : null;
    return { items, nextCursor, refreshed };
  }

  private async readSession(userId: string): Promise<Session | null> {
    const raw = await this.redis.get(forYouUserKey(userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Session;
      return typeof parsed.g === "string" && Array.isArray(parsed.ids) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Spreads creators over blocks of one page and keeps the first FOR_YOU_MAX_IDS. */
  private spread(ranked: Array<{ id: string; creatorId: string }>, block: number): string[] {
    return interleave(ranked, block).slice(0, FOR_YOU_MAX_IDS).map((r) => r.id);
  }

  /** A signed-in viewer's fresh list: ranked for them, spread over blocks of `limit`, stored under their one key with a new generation. */
  private async startSession(viewerId: string, limit: number): Promise<{ g: string; ids: string[]; offset: number; block: number }> {
    const ids = this.spread(await this.rankFor(viewerId), limit);
    const g = randomUUID();
    await this.redis.set(forYouUserKey(viewerId), JSON.stringify({ g, ids } satisfies Session), "EX", FOR_YOU_SESSION_TTL_SEC);
    return { g, ids, offset: 0, block: limit };
  }

  private async startShared(limit: number): Promise<{ g: string; ids: string[]; offset: number; block: number }> {
    const shared = await this.globalList();
    return { g: shared.g, ids: this.spread(shared.ranked, limit), offset: 0, block: limit };
  }

  /** The one ranking every signed-out viewer shares: no interests, nothing seen; rebuilt every five minutes. */
  private async globalList(): Promise<GlobalList> {
    const cached = await this.redis.get(FOR_YOU_GLOBAL_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as GlobalList;
        if (typeof parsed.g === "string" && Array.isArray(parsed.ranked)) return parsed;
      } catch {
        // rebuild below
      }
    }
    const ranked = rankReels(await this.candidates(), this.clock.now(), new Map(), new Set()).map(({ id, creatorId }) => ({ id, creatorId }));
    const list: GlobalList = { g: randomUUID(), ranked };
    await this.redis.set(FOR_YOU_GLOBAL_KEY, JSON.stringify(list), "EX", FOR_YOU_GLOBAL_TTL_SEC);
    return list;
  }

  private async rankFor(userId: string): Promise<Array<{ id: string; creatorId: string }>> {
    const now = this.clock.now();
    const [candidates, interests] = await Promise.all([this.candidates(), this.interests.weights(userId, now)]);
    const seen = new Set(
      candidates.length === 0 ? [] : (await this.prisma.reelSeen.findMany({ where: { userId, reelId: { in: candidates.map((c) => c.id) } }, select: { reelId: true } })).map((s) => s.reelId),
    );
    return rankReels(candidates, now, normaliseInterests(interests), seen).map(({ id, creatorId }) => ({ id, creatorId }));
  }

  /**
   * Published reels of the last 7 days: the newest 300 and the 300 most engaging (the engagement rate the ranking uses), de-duplicated, so a hit from
   * three days ago is not pushed out by a flood of new uploads. If that is under 100, the most engaging of days 7-30 top it up.
   * The 7-day range comes from the (status, publishedAt) index; the engagement order is a top-N sort over that range.
   */
  private async candidates(): Promise<FeedReel[]> {
    const now = this.clock.now();
    const recentSince = new Date(now.getTime() - RECENT_DAYS * DAY_MS);
    const rows: CandidateRow[] = await this.prisma.reel.findMany({
      where: { status: "PUBLISHED", publishedAt: { gte: recentSince } },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: RECENT_TAKE,
      select: CANDIDATE_SELECT,
    });
    const have = new Set(rows.map((r) => r.id));
    const engaging = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "reels"
      WHERE "status" = 'PUBLISHED'::"ReelStatus" AND "publishedAt" >= ${recentSince}
      ORDER BY ${ENGAGEMENT_RATE_SQL} DESC, "publishedAt" DESC, "id" DESC
      LIMIT ${ENGAGING_TAKE}`);
    const more = engaging.map((r) => r.id).filter((id) => !have.has(id));
    if (more.length > 0) rows.push(...(await this.prisma.reel.findMany({ where: { id: { in: more } }, select: CANDIDATE_SELECT })));
    if (rows.length < MIN_CANDIDATES) {
      const fillSince = new Date(now.getTime() - FILL_DAYS * DAY_MS);
      const top = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "reels"
        WHERE "status" = 'PUBLISHED'::"ReelStatus" AND "publishedAt" >= ${fillSince} AND "publishedAt" < ${recentSince}
        ORDER BY ${ENGAGEMENT_RATE_SQL} DESC, "publishedAt" DESC, "id" DESC
        LIMIT ${MIN_CANDIDATES - rows.length}`);
      if (top.length > 0) rows.push(...(await this.prisma.reel.findMany({ where: { id: { in: top.map((r) => r.id) } }, select: CANDIDATE_SELECT })));
    }
    const categories = await this.categories.ofCourses([...new Set(rows.flatMap((r) => (r.linkedCourseId ? [r.linkedCourseId] : [])))]);
    return rows.map((r) => ({ ...r, publishedAt: r.publishedAt!, categoryId: r.linkedCourseId ? (categories.get(r.linkedCourseId) ?? null) : null }));
  }
}
