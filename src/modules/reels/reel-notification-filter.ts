import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { UserBlocks } from "../moderation";
import { NotificationFilters, type FilterableNotification } from "../notifications";

const ACTIVITY_TYPES = new Set(["reel.like", "reel.comment", "reel.reply"]);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Likes, comments and replies on reels are about someone else's action on a reel: they are not shown once the reel left the public (hidden, removed,
 * deleted), once the comment did, or when the member behind it is blocked either way. Notifications about the user's own reel's lifecycle
 * (live, failed, waiting for the daily limit) are never filtered.
 */
@Injectable()
export class ReelNotificationFilter implements OnModuleInit {
  constructor(
    private readonly filters: NotificationFilters,
    private readonly prisma: PrismaService,
    private readonly blocks: UserBlocks,
  ) {}

  onModuleInit() {
    this.filters.register({ types: [...ACTIVITY_TYPES], hidden: (userId, rows) => this.hidden(userId, rows) });
  }

  private async hidden(userId: string, rows: FilterableNotification[]): Promise<Set<string>> {
    const rel = rows.filter((r) => ACTIVITY_TYPES.has(r.type));
    const out = new Set<string>();
    if (rel.length === 0) return out;
    const data = (r: FilterableNotification) => (r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {});
    const reelIds = [...new Set(rel.flatMap((r) => str(data(r).reelId) ?? []))];
    const commentIds = [...new Set(rel.flatMap((r) => [str(data(r).commentId), str(data(r).replyId)].flatMap((v) => v ?? [])))];
    const [{ blocked }, live, comments] = await Promise.all([
      this.blocks.relations(userId),
      reelIds.length ? this.prisma.reel.findMany({ where: { id: { in: reelIds }, status: "PUBLISHED" }, select: { id: true } }) : [],
      commentIds.length ? this.prisma.reelComment.findMany({ where: { id: { in: commentIds }, status: "VISIBLE" }, select: { id: true } }) : [],
    ]);
    const liveReels = new Set(live.map((r) => r.id));
    const liveComments = new Set(comments.map((c) => c.id));
    for (const r of rel) {
      const d = data(r);
      const reelId = str(d.reelId);
      const actor = str(d.actorId);
      // A reply notification names the top-level comment it sits under (commentId) and the reply itself (replyId): the reply is what must be visible.
      const ref = str(d.replyId) ?? str(d.commentId);
      if ((reelId && !liveReels.has(reelId)) || (actor && blocked.has(actor)) || (ref && !liveComments.has(ref))) out.add(r.id);
    }
    return out;
  }
}
