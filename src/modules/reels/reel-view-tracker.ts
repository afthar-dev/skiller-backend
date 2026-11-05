import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { istDateOf } from "../billing";
import { MediaAttachments } from "../media";
import { reelNotFound } from "./reel-rules";
import { PENDING_VIEWS_KEY, viewersKey } from "./reel-view-flusher";

/** A view counts after this many seconds of watching. */
export const MIN_WATCH_SEC = 3;
/** Reels are at most 90 s; used when a video has no recorded duration. */
const MAX_REEL_SEC = 90;
/** Dedupe keys outlive the IST day they belong to (24 h + an hour of slack). */
const SEEN_TTL_SEC = 90_000;
/** Anonymous viewers: beacons per address per hour (counted or not). */
export const ANON_VIEWS_PER_IP_PER_HOUR = 300;
/** Watching this share of a reel counts as interest in it. */
export const INTEREST_VIEW_PCT = 50;
const VIEWERS_TTL_SEC = 3 * 24 * 3600;

export interface ViewInput {
  reelId: string;
  watchedSec: number;
  /** The signed-in viewer, if any. */
  userId: string | null;
  /** A well-formed device id from the cookie, or null (missing or malformed). */
  deviceId: string | null;
  /** The device id this response hands out, when the request had no usable one. */
  issuedDeviceId: string | null;
  ip: string;
  userAgent: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Records "watched at least 3 s" beacons. A view is counted at most once per viewer per reel per IST day (Redis SET NX), where the viewer is the
 * signed-in user (the same on every device), else the anonymous device id, else (no usable cookie) address + browser. Counts go to a Redis hash that
 * ReelViewFlusher writes to Postgres; the unique-viewer HyperLogLog is approximate by nature.
 *
 * What this does not stop: someone who sends a fresh device id with every beacon is a new viewer each time, up to 300 beacons an hour per
 * address (the cap applies to anonymous beacons, replays included). That bounds inflation from one address; it does not make it zero.
 */
@Injectable()
export class ReelViewTracker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly media: MediaAttachments,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(input: ViewInput): Promise<{ counted: boolean }> {
    const reel = await this.prisma.reel.findUnique({ where: { id: input.reelId }, select: { id: true, status: true, creatorId: true, mediaAssetId: true } });
    if (!reel || reel.status !== "PUBLISHED") throw reelNotFound();
    if (input.watchedSec < MIN_WATCH_SEC) return { counted: false };
    if (reel.creatorId === input.userId) return { counted: false };

    const duration = (await this.media.assetInfo(reel.mediaAssetId))?.durationSec ?? MAX_REEL_SEC;
    const watched = Math.floor(Math.min(input.watchedSec, duration > 0 ? duration : MAX_REEL_SEC));
    const now = this.clock.now();
    const day = istDateOf(now);

    if (input.userId) {
      await this.markSeen(input.userId, reel.id, watched, duration, now);
    } else {
      try {
        await consumeRateLimit(this.redis, `reelviews:anon:${input.ip}`, ANON_VIEWS_PER_IP_PER_HOUR, 3600);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") return { counted: false };
        throw err;
      }
    }

    const { viewerKey, first, aliases } = await this.claim("reelview", reel.id, day, input);
    // Every beacon adds what was watched beyond the viewer's best so far today (a seek back adds nothing); the view itself counts once.
    const extra = await this.watchedBeyondBest(reel.id, day, [viewerKey, ...aliases], watched);
    if (!first && extra === 0) return { counted: false };

    const m = this.redis.multi();
    if (first) m.hincrby(PENDING_VIEWS_KEY, `${reel.id}:${day}:v`, 1);
    if (extra > 0) m.hincrby(PENDING_VIEWS_KEY, `${reel.id}:${day}:w`, extra);
    if (first) m.pfadd(viewersKey(reel.id, day), viewerKey).expire(viewersKey(reel.id, day), VIEWERS_TTL_SEC);
    await m.exec();
    return { counted: first };
  }

  /**
   * The viewer's best watched seconds so far for this reel and IST day lives in Redis (one key per viewer identity; a cookie-less browser and the
   * cookie it was given share the best). One Lua step reads the best, raises it to `watched` and returns the increase, so concurrent beacons never
   * add the same seconds twice. The caller already capped `watched` at the duration.
   */
  private async watchedBeyondBest(reelId: string, day: string, viewers: string[], watched: number): Promise<number> {
    const keys = viewers.map((v) => `reelwatch:${reelId}:${day}:${v}`);
    const script = `local best = 0
for i = 1, #KEYS do local v = tonumber(redis.call("GET", KEYS[i]) or "0"); if v > best then best = v end end
local w = tonumber(ARGV[1])
if w <= best then return 0 end
for i = 1, #KEYS do redis.call("SET", KEYS[i], w, "EX", ARGV[2]) end
return w - best`;
    return Number(await this.redis.eval(script, keys.length, ...keys, String(watched), String(SEEN_TTL_SEC)));
  }

  /**
   * The "View course" card was clicked. Same viewer rules as a view (one per viewer per reel per IST day, anonymous beacons capped per address),
   * but needs no watch time. Only a reel that links a course counts; the creator's own clicks do not.
   */
  async recordLinkClick(input: Omit<ViewInput, "watchedSec">): Promise<{ counted: boolean }> {
    const reel = await this.prisma.reel.findUnique({ where: { id: input.reelId }, select: { id: true, status: true, creatorId: true, linkedCourseId: true, linkedGigId: true } });
    if (!reel || reel.status !== "PUBLISHED") throw reelNotFound();
    if ((!reel.linkedCourseId && !reel.linkedGigId) || reel.creatorId === input.userId) return { counted: false };
    if (!input.userId) {
      try {
        await consumeRateLimit(this.redis, `reellinks:anon:${input.ip}`, ANON_VIEWS_PER_IP_PER_HOUR, 3600);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") return { counted: false };
        throw err;
      }
    }
    const day = istDateOf(this.clock.now());
    if (!(await this.claim("reellink", reel.id, day, input)).first) return { counted: false };
    await this.redis.hincrby(PENDING_VIEWS_KEY, `${reel.id}:${day}:c`, 1);
    return { counted: true };
  }

  /** Marks the viewer as having acted on this reel today: true only for the first time. `prefix` keeps views and clicks apart. */
  private async claim(prefix: string, reelId: string, day: string, input: Pick<ViewInput, "userId" | "deviceId" | "issuedDeviceId" | "ip" | "userAgent">): Promise<{ viewerKey: string; first: boolean; aliases: string[] }> {
    const seen = async (viewer: string) => (await this.redis.set(`${prefix}:seen:${reelId}:${day}:${viewer}`, "1", "EX", SEEN_TTL_SEC, "NX")) === "OK";
    if (input.userId) {
      const viewerKey = `u:${input.userId}`;
      return { viewerKey, first: await seen(viewerKey), aliases: [] };
    }
    if (input.deviceId) {
      const viewerKey = `d:${input.deviceId}`;
      return { viewerKey, first: await seen(viewerKey), aliases: [] };
    }
    // No usable cookie: address + browser decides, and the device id handed out now is marked too, so the next beacon (which carries it) is not a second one.
    const viewerKey = `ip:${input.ip}|${sha256(input.userAgent)}`;
    const first = await seen(viewerKey);
    if (input.issuedDeviceId) await seen(`d:${input.issuedDeviceId}`);
    return { viewerKey, first, aliases: input.issuedDeviceId ? [`d:${input.issuedDeviceId}`] : [] };
  }

  /** What a signed-in user has watched; updated on every beacon, counted or not. */
  private async markSeen(userId: string, reelId: string, watched: number, duration: number, now: Date) {
    const pct = duration > 0 ? Math.min(100, Math.round((watched / duration) * 100)) : 0;
    // Watching at least half is a signal of interest, sent once per reel (when the share first reaches the threshold).
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.reelSeen.findUnique({ where: { userId_reelId: { userId, reelId } }, select: { watchedPct: true } });
      await tx.reelSeen.upsert({
        where: { userId_reelId: { userId, reelId } },
        create: { userId, reelId, lastSeenAt: now, watchedPct: pct },
        update: { lastSeenAt: now, watchedPct: Math.max(pct, before?.watchedPct ?? 0) },
      });
      if (pct >= INTEREST_VIEW_PCT && (before?.watchedPct ?? 0) < INTEREST_VIEW_PCT) await this.outbox.enqueue(tx, { type: "reel.engaged", userId, reelId, kind: "view" });
    });
  }
}
