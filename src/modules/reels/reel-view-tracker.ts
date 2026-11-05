import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
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

    const seen = async (viewer: string) => (await this.redis.set(`reelview:seen:${reel.id}:${day}:${viewer}`, "1", "EX", SEEN_TTL_SEC, "NX")) === "OK";
    let viewerKey: string;
    let first: boolean;
    if (input.userId) {
      viewerKey = `u:${input.userId}`;
      first = await seen(viewerKey);
    } else if (input.deviceId) {
      viewerKey = `d:${input.deviceId}`;
      first = await seen(viewerKey);
    } else {
      // No usable cookie: address + browser decides, and the device id handed out now is marked too, so the next beacon (which carries it) is not a second view.
      viewerKey = `ip:${input.ip}|${sha256(input.userAgent)}`;
      first = await seen(viewerKey);
      if (input.issuedDeviceId) await seen(`d:${input.issuedDeviceId}`);
    }
    if (!first) return { counted: false };

    await this.redis
      .multi()
      .hincrby(PENDING_VIEWS_KEY, `${reel.id}:${day}:v`, 1)
      .hincrby(PENDING_VIEWS_KEY, `${reel.id}:${day}:w`, watched)
      .pfadd(viewersKey(reel.id, day), viewerKey)
      .expire(viewersKey(reel.id, day), VIEWERS_TTL_SEC)
      .exec();
    return { counted: true };
  }

  /** What a signed-in user has watched; updated on every beacon, counted or not. */
  private async markSeen(userId: string, reelId: string, watched: number, duration: number, now: Date) {
    const pct = duration > 0 ? Math.min(100, Math.round((watched / duration) * 100)) : 0;
    await this.prisma.reelSeen.upsert({
      where: { userId_reelId: { userId, reelId } },
      create: { userId, reelId, lastSeenAt: now, watchedPct: pct },
      update: { lastSeenAt: now, watchedPct: pct },
    });
  }
}
