import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import type { PageQuery } from "../../common/http/pagination";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { istDateOf } from "../billing";
import { bumpCounter, readCounter } from "./reel-counters";
import { ReelNotifier } from "./reel-notifier";
import { reelNotFound } from "./reel-rules";
import { ReelViews, type ReelView } from "./reel-views";

export const SHARE_CHANNELS = ["copy_link", "whatsapp", "telegram", "twitter", "facebook", "instagram", "email", "other"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export const LIKES_PER_MINUTE = 120;
export const SAVES_PER_MINUTE = 120;
export const SHARES_PER_MINUTE = 30;

const SAVED_REELS_CURSOR = "saved-reels";
const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;

/**
 * Likes, saves and shares. Each is a conditional row change (insert ... ON CONFLICT DO NOTHING / delete) and the denormalised counter moves
 * only when a row really changed, in the same transaction. So double taps, two devices and an unlike racing a like all end with
 * counter = number of rows, and a retried request changes nothing.
 */
@Injectable()
export class EngagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: ReelNotifier,
    private readonly views: ReelViews,
    private readonly cursors: SignedCursor,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async like(userId: string, reelId: string): Promise<{ liked: true; likeCount: number }> {
    const reel = await this.visibleReel(reelId);
    await consumeRateLimit(this.redis, `reel-like:${userId}`, LIKES_PER_MINUTE, 60);
    const { changed, count } = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.reelLike.createMany({ data: [{ reelId, userId, createdAt: this.clock.now() }], skipDuplicates: true });
      return inserted.count === 1 ? { changed: true, count: await bumpCounter(tx, reelId, "likes", 1) } : { changed: false, count: await readCounter(tx, reelId, "likes") };
    }, TX_OPTIONS);
    if (changed) {
      await this.notifier.notifyCreatorOfActivity("like", reel, userId, { type: "reel.like", title: "Your reel is getting likes", body: "People are liking your reel.", link: `/reels/${reelId}` });
    }
    return { liked: true, likeCount: count };
  }

  async unlike(userId: string, reelId: string): Promise<{ liked: false; likeCount: number }> {
    await this.visibleReel(reelId);
    await consumeRateLimit(this.redis, `reel-like:${userId}`, LIKES_PER_MINUTE, 60);
    const count = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.reelLike.deleteMany({ where: { reelId, userId } });
      return removed.count === 1 ? bumpCounter(tx, reelId, "likes", -1) : readCounter(tx, reelId, "likes");
    }, TX_OPTIONS);
    return { liked: false, likeCount: count };
  }

  async save(userId: string, reelId: string): Promise<{ saved: true; saveCount: number }> {
    await this.visibleReel(reelId);
    await consumeRateLimit(this.redis, `reel-save:${userId}`, SAVES_PER_MINUTE, 60);
    const count = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.reelSave.createMany({ data: [{ reelId, userId, createdAt: this.clock.now() }], skipDuplicates: true });
      return inserted.count === 1 ? bumpCounter(tx, reelId, "saves", 1) : readCounter(tx, reelId, "saves");
    }, TX_OPTIONS);
    return { saved: true, saveCount: count };
  }

  async unsave(userId: string, reelId: string): Promise<{ saved: false; saveCount: number }> {
    await this.visibleReel(reelId);
    await consumeRateLimit(this.redis, `reel-save:${userId}`, SAVES_PER_MINUTE, 60);
    const count = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.reelSave.deleteMany({ where: { reelId, userId } });
      return removed.count === 1 ? bumpCounter(tx, reelId, "saves", -1) : readCounter(tx, reelId, "saves");
    }, TX_OPTIONS);
    return { saved: false, saveCount: count };
  }

  /**
   * A share counts once per signed-in user per reel per IST day (another channel the same day is not a second share). Anonymous shares are
   * accepted (and rate limited per IP) but never counted: they cannot be told apart.
   */
  async share(userId: string | null, ip: string, reelId: string, channel: ShareChannel): Promise<{ counted: boolean; shareCount: number }> {
    const reel = await this.visibleReel(reelId);
    if (!userId) {
      await consumeRateLimit(this.redis, `reel-share-ip:${ip}`, SHARES_PER_MINUTE, 60);
      return { counted: false, shareCount: reel.shareCount };
    }
    await consumeRateLimit(this.redis, `reel-share:${userId}`, SHARES_PER_MINUTE, 60);
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.reelShare.createMany({ data: [{ reelId, userId, channel, day: istDateOf(now), createdAt: now }], skipDuplicates: true });
      const counted = inserted.count === 1;
      return { counted, shareCount: counted ? await bumpCounter(tx, reelId, "shares", 1) : await readCounter(tx, reelId, "shares") };
    }, TX_OPTIONS);
  }

  /** The viewer's saved reels that are still public, most recently saved first. */
  async savedReels(userId: string, page: PageQuery): Promise<{ items: ReelView[]; nextCursor: string | null }> {
    let after: { t: Date; id: string } | undefined;
    if (page.cursor) {
      const c = this.cursors.verify(SAVED_REELS_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      after = { t, id: c.id };
    }
    const rows = await this.prisma.reelSave.findMany({
      where: {
        userId,
        reel: { status: "PUBLISHED" },
        ...(after ? { OR: [{ createdAt: { lt: after.t } }, { createdAt: after.t, reelId: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { reelId: "desc" }],
      take: page.limit + 1,
      include: { reel: true },
    });
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > page.limit && last ? this.cursors.sign(SAVED_REELS_CURSOR, { t: last.createdAt.toISOString(), id: last.reelId }) : null;
    return { items: await this.views.build(items.map((r) => r.reel), userId), nextCursor };
  }

  /** A reel the public can see (published); anything else does not exist for engagement. */
  private async visibleReel(reelId: string) {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || reel.status !== "PUBLISHED") throw reelNotFound();
    return reel;
  }
}
