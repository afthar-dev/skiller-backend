import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MediaAttachments } from "../media";
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
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "REEL",
      ownerOf: async (id) => {
        const reel = await this.prisma.reel.findUnique({ where: { id }, select: { creatorId: true, status: true } });
        return reel && (reel.status === "PUBLISHED" || reel.status === "HIDDEN") ? reel.creatorId : null;
      },
      hide: (tx, id) => this.moveReel(tx, id, ["PUBLISHED"], "HIDDEN"),
      remove: (tx, id) => this.moveReel(tx, id, ["PUBLISHED", "HIDDEN"], "REMOVED"),
      restore: (tx, id) => this.moveReel(tx, id, ["HIDDEN"], "PUBLISHED"),
      preview: async (id) => {
        const reel = await this.prisma.reel.findUnique({ where: { id }, select: { caption: true, status: true } });
        return reel ? { text: reel.caption, status: reel.status } : null;
      },
    });

    this.registry.register({
      type: "REEL_COMMENT",
      ownerOf: async (id) => {
        const c = await this.prisma.reelComment.findUnique({ where: { id }, select: { userId: true, status: true } });
        return c && (c.status === "VISIBLE" || c.status === "HIDDEN") ? c.userId : null;
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
    // A removed reel's video is released: the media cleanup deletes it like any abandoned upload.
    if (to === "REMOVED") await this.media.detach(tx, reel.mediaAssetId);
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
