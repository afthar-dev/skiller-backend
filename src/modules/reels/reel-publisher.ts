import { Inject, Injectable } from "@nestjs/common";
import type { Reel } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EntitlementsService, istDateOf, istDayRange } from "../billing";
import { MediaAttachments } from "../media";
import { adjustHashtags } from "./hashtag-counts";
import { ReelNotifier } from "./reel-notifier";
import { reelNotFound } from "./reel-rules";

/** What a publish attempt did: the reel went live, hit the daily limit (newly, or it was already waiting), is still waiting for its video, failed, or was not in a state to change. */
export type PublishOutcome = "published" | "limit" | "limit_again" | "waiting" | "failed" | "noop";

const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;

/**
 * The one place a reel goes live. Runs in the API (the creator posts a finished video, or retries after a limit) and in the worker
 * (media.ready). The daily limit is checked under a per-creator advisory lock and counts publish events (`publishedAt` in the creator's
 * IST day, deleted reels included), so parallel publishes, delete-and-repost and the midnight boundary all see the same count.
 */
@Injectable()
export class ReelPublisher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaAttachments,
    private readonly entitlements: EntitlementsService,
    private readonly notifier: ReelNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Idempotent. Publishes a PROCESSING or LIMIT_REACHED reel whose video is READY; `eventId` (the outbox event) makes the notification idempotent. */
  async publish(reelId: string, opts: { eventId?: string } = {}): Promise<{ reel: Reel; outcome: PublishOutcome }> {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel) throw reelNotFound();
    if (reel.status !== "PROCESSING" && reel.status !== "LIMIT_REACHED") return { reel, outcome: "noop" };

    const info = await this.media.assetInfo(reel.mediaAssetId);
    if (!info || info.status === "FAILED") return this.fail(reel, "MEDIA_FAILED", opts.eventId);
    if (info.status !== "READY") return { reel, outcome: "waiting" };

    const limit = await this.entitlements.limit({ ownerType: "USER", ownerId: reel.creatorId }, "reels_per_day");
    const now = this.clock.now();
    const { from, to } = istDayRange(istDateOf(now));

    let outcome: PublishOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx): Promise<PublishOutcome> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reels-publish:${reel.creatorId}`}))`;
        const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "reels" WHERE "id" = ${reelId} FOR UPDATE`;
        const status = locked[0]?.status;
        if (status !== "PROCESSING" && status !== "LIMIT_REACHED") return "noop";
        // The video is protected from the orphan cleanup as soon as the reel decides about it, whatever the limit says.
        if (status === "PROCESSING") await this.media.attach(tx, reel.mediaAssetId, reel.creatorId, "REEL");
        const used = await tx.reel.count({ where: { creatorId: reel.creatorId, publishedAt: { gte: from, lt: to } } });
        if (limit !== null && used >= limit) {
          if (status === "LIMIT_REACHED") return "limit_again";
          await tx.reel.update({ where: { id: reelId }, data: { status: "LIMIT_REACHED" } });
          return "limit";
        }
        const current = await tx.reel.findUniqueOrThrow({ where: { id: reelId }, select: { hashtags: true } });
        await tx.reel.update({ where: { id: reelId }, data: { status: "PUBLISHED", publishedAt: now, failureReason: null } });
        await adjustHashtags(tx, { add: current.hashtags }, now);
        return "published";
      }, TX_OPTIONS);
    } catch (err) {
      if (err instanceof AppError && err.code === "MEDIA_NOT_USABLE") return this.fail(reel, "MEDIA_NOT_USABLE", opts.eventId);
      throw err;
    }

    const fresh = await this.prisma.reel.findUniqueOrThrow({ where: { id: reelId } });
    if (outcome === "published" && opts.eventId) {
      await this.notifier.notifyUser(reel.creatorId, { type: "reel.published", title: "Your reel is live", body: "Processing has finished and your reel is now public.", link: `/reels/${reelId}`, data: { reelId }, sourceEventId: opts.eventId });
    } else if (outcome === "limit") {
      await this.notifier.notifyUser(reel.creatorId, {
        type: "reel.limit_reached",
        title: "Your reel is waiting for tomorrow",
        body: "You have posted as many reels today as your plan allows. Publish it again after midnight IST, or upgrade your plan.",
        link: `/reels/${reelId}`,
        data: { reelId },
        sourceEventId: opts.eventId,
      });
    }
    return { reel: fresh, outcome };
  }

  /** PROCESSING -> FAILED, once; tells the creator. A reel in any other state is left alone. */
  async fail(reel: Pick<Reel, "id" | "creatorId">, reason: string, eventId?: string): Promise<{ reel: Reel; outcome: PublishOutcome }> {
    const changed = await this.prisma.reel.updateMany({ where: { id: reel.id, status: "PROCESSING" }, data: { status: "FAILED", failureReason: reason } });
    if (changed.count === 1) {
      await this.notifier.notifyUser(reel.creatorId, {
        type: "reel.failed",
        title: "Your reel could not be published",
        body: "The video could not be processed, so the reel was not published. Upload the video again to post it.",
        data: { reelId: reel.id, reason },
        sourceEventId: eventId,
      });
    }
    return { reel: await this.prisma.reel.findUniqueOrThrow({ where: { id: reel.id } }), outcome: changed.count === 1 ? "failed" : "noop" };
  }
}
