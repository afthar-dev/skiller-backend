import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MediaAttachments, MediaPurger } from "../media";
import { ModerationTargetRegistry } from "../moderation";
import { adjustHashtags } from "./hashtag-counts";
import { bumpCounter } from "./reel-counters";

/**
 * Reels and reel comments as reportable content. Everything moderation does to them keeps the denormalised numbers right in the same transaction:
 * a PUBLISHED reel counts in `hashtags.reelCount`, a VISIBLE comment counts in the reel's `commentCount`.
 */
@Injectable()
export class ReelModerationTargets implements OnModuleInit {
  constructor(
    private readonly registry: ModerationTargetRegistry,
    private readonly prisma: PrismaService,
    private readonly media: MediaAttachments,
    private readonly purger: MediaPurger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "REEL",
      // Whatever the state: a creator who deleted a reported reel is still struck when the reports are upheld.
      ownerOf: async (id) => (await this.prisma.reel.findUnique({ where: { id }, select: { creatorId: true } }))?.creatorId ?? null,
      reportable: async (id) => {
        const reel = await this.prisma.reel.findUnique({ where: { id }, select: { status: true } });
        return reel?.status === "PUBLISHED" || reel?.status === "HIDDEN";
      },
      hide: (tx, id) => this.moveReel(tx, id, ["PUBLISHED"], "HIDDEN"),
      remove: async (tx, id) => {
        if (await this.moveReel(tx, id, ["PUBLISHED", "HIDDEN"], "REMOVED")) return true;
        // Deleted while reported: it stays DELETED (the daily limit counts it), but its video was kept as evidence and is now taken down.
        const deleted = await tx.reel.findFirst({ where: { id, status: "DELETED" }, select: { mediaAssetId: true } });
        if (deleted) await this.media.takedown(tx, deleted.mediaAssetId);
        return false;
      },
      onDismiss: async (tx, id) => {
        // Deleted while reported and the reports were rejected: the video was kept only for the decision; release it for the normal cleanup.
        const rows = await tx.$queryRaw<{ status: string; mediaAssetId: string }[]>`SELECT "status"::text AS "status", "mediaAssetId" FROM "reels" WHERE "id" = ${id} FOR UPDATE`;
        if (rows[0]?.status === "DELETED") await this.media.detach(tx, rows[0].mediaAssetId);
      },
      afterUphold: async (id) => {
        const reel = await this.prisma.reel.findUnique({ where: { id }, select: { mediaAssetId: true, status: true } });
        if (reel && (reel.status === "REMOVED" || reel.status === "DELETED")) await this.purger.purge(reel.mediaAssetId);
      },
      restore: (tx, id) => this.moveReel(tx, id, ["HIDDEN"], "PUBLISHED"),
      preview: async (id) => {
        const reel = await this.prisma.reel.findUnique({ where: { id }, select: { caption: true, status: true } });
        return reel ? { text: reel.caption, status: reel.status } : null;
      },
    });

    this.registry.register({
      type: "REEL_COMMENT",
      ownerOf: async (id) => (await this.prisma.reelComment.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? null,
      reportable: async (id) => {
        const c = await this.prisma.reelComment.findUnique({ where: { id }, select: { status: true } });
        return c?.status === "VISIBLE" || c?.status === "HIDDEN";
      },
      hide: (tx, id) => this.moveComment(tx, id, "VISIBLE", "HIDDEN"),
      remove: async (tx, id) => (await this.moveComment(tx, id, "VISIBLE", "REMOVED")) || (await this.moveComment(tx, id, "HIDDEN", "REMOVED")),
      restore: (tx, id) => this.moveComment(tx, id, "HIDDEN", "VISIBLE"),
      preview: async (id) => {
        const c = await this.prisma.reelComment.findUnique({ where: { id }, select: { body: true, status: true } });
        return c ? { text: c.body, status: c.status } : null;
      },
    });
  }

  /** Moves a reel between statuses under its row lock, keeping the hashtag counts right: they count PUBLISHED reels only. */
  private async moveReel(tx: Prisma.TransactionClient, id: string, from: Array<"PUBLISHED" | "HIDDEN">, to: "HIDDEN" | "REMOVED" | "PUBLISHED"): Promise<boolean> {
    const rows = await tx.$queryRaw<{ status: string; hashtags: string[]; mediaAssetId: string }[]>`SELECT "status"::text AS "status", "hashtags", "mediaAssetId" FROM "reels" WHERE "id" = ${id} FOR UPDATE`;
    const reel = rows[0];
    if (!reel || !(from as string[]).includes(reel.status)) return false;
    await tx.reel.update({ where: { id }, data: { status: to } });
    const now = this.clock.now();
    if (reel.status === "PUBLISHED") await adjustHashtags(tx, { remove: reel.hashtags }, now);
    else if (to === "PUBLISHED") await adjustHashtags(tx, { add: reel.hashtags }, now);
    // A removed reel's video is taken down: purged right after the decision commits (afterUphold), by the hourly cleanup at the latest.
    if (to === "REMOVED") await this.media.takedown(tx, reel.mediaAssetId);
    return true;
  }

  /** Moves a comment between statuses; the reel's comment count follows (it counts VISIBLE comments), only when the status really changed. */
  private async moveComment(tx: Prisma.TransactionClient, id: string, from: "VISIBLE" | "HIDDEN", to: "VISIBLE" | "HIDDEN" | "REMOVED"): Promise<boolean> {
    const comment = await tx.reelComment.findUnique({ where: { id }, select: { reelId: true } });
    if (!comment) return false;
    const changed = await tx.reelComment.updateMany({ where: { id, status: from }, data: { status: to } });
    if (changed.count === 0) return false;
    if (from === "VISIBLE") await bumpCounter(tx, comment.reelId, "comments", -1);
    else if (to === "VISIBLE") await bumpCounter(tx, comment.reelId, "comments", 1);
    return true;
  }
}
