import { Inject, Injectable } from "@nestjs/common";
import type { Reel, ReelComment } from "@prisma/client";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { sanitizePlainText } from "../courses";
import { MediaService } from "../media";
import { PostingRestrictions, UserBlocks } from "../moderation";
import { ProfilesService } from "../users";
import { bumpCounter } from "./reel-counters";
import { ReelNotifier } from "./reel-notifier";
import { reelNotFound } from "./reel-rules";
import { ReelVisibility } from "./reel-visibility";

export const COMMENT_MAX = 1000;
export const COMMENTS_PER_MINUTE = 30;
export const DELETED_COMMENT_BODY = "[deleted]";

const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
const commentNotFound = () => new AppError("COMMENT_NOT_FOUND", 404, "Comment not found");
const commentsDisabled = () => new AppError("COMMENTS_DISABLED", 403, "The creator turned comments off for this reel");

export interface CommentAuthor {
  id: string;
  handle: string;
  displayName: string;
  avatar: Record<string, string> | null;
}

export interface CommentView {
  id: string;
  reelId: string;
  /** The top-level comment this is a reply to; null for a top-level comment. */
  parentId: string | null;
  /** "[deleted]" for a deleted comment that stays because it has replies. */
  body: string;
  status: "VISIBLE" | "DELETED";
  /** Null for a deleted comment. */
  author: CommentAuthor | null;
  /** Visible replies (top-level comments only). */
  replyCount: number;
  createdAt: string;
  editedAt: string | null;
  /** Present for signed-in viewers: the comment is theirs. */
  mine?: boolean;
}

/**
 * Comments with one level of replies. `commentCount` on the reel counts VISIBLE comments and replies: it moves in the transaction of the row change
 * and only when the status really changed. Deleting is a soft delete; a top-level comment with replies stays as a "[deleted]" placeholder so the thread
 * survives, otherwise it disappears from the list.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly profiles: ProfilesService,
    private readonly media: MediaService,
    private readonly notifier: ReelNotifier,
    private readonly visibility: ReelVisibility,
    private readonly blocks: UserBlocks,
    private readonly restrictions: PostingRestrictions,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(userId: string, reelId: string, input: { body: string; parentId?: string }): Promise<CommentView> {
    await this.restrictions.assertCanPost(userId);
    const reel = await this.visibleReel(reelId, userId);
    if (!reel.commentsEnabled) throw commentsDisabled();
    const body = this.requireBody(input.body);
    let parent: ReelComment | null = null;
    let topLevelId: string | null = null;
    if (input.parentId) {
      parent = await this.prisma.reelComment.findFirst({ where: { id: input.parentId, reelId, status: "VISIBLE" } });
      // A comment by someone who blocked you (or you blocked) does not exist for you: no replying to it.
      if (!parent || (await this.blocks.isBlockedEitherWay(userId, parent.userId))) throw commentNotFound();
      topLevelId = parent.parentId ?? parent.id; // a reply to a reply joins the top-level comment's thread
    }
    await consumeRateLimit(this.redis, `reel-comment:${userId}`, COMMENTS_PER_MINUTE, 60);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.reelComment.create({ data: { reelId, userId, parentId: topLevelId, body, createdAt: this.clock.now() } });
      await bumpCounter(tx, reelId, "comments", 1);
      await this.outbox.enqueue(tx, { type: "reel.engaged", userId, reelId, kind: "comment" });
      return row;
    }, TX_OPTIONS);

    if (parent && parent.userId !== userId) {
      await this.notifier.notifyUser(parent.userId, {
        type: "reel.reply",
        title: "Someone replied to your comment",
        body: body.slice(0, 140),
        link: `/reels/${reelId}`,
        data: { reelId, commentId: topLevelId, replyId: created.id, actorId: userId },
      }, userId);
    }
    // The creator hears about the comment unless they wrote it, or they are the person just notified of the reply.
    if (!parent || parent.userId !== reel.creatorId) {
      await this.notifier.notifyCreatorOfActivity("comment", reel, userId, { type: "reel.comment", title: "New comment on your reel", body: body.slice(0, 140), link: `/reels/${reelId}`, data: { commentId: created.id } });
    }
    return (await this.views([created], userId))[0];
  }

  async edit(userId: string, reelId: string, commentId: string, rawBody: string): Promise<CommentView> {
    await this.visibleReel(reelId, userId);
    const body = this.requireBody(rawBody);
    await consumeRateLimit(this.redis, `reel-comment:${userId}`, COMMENTS_PER_MINUTE, 60);
    const changed = await this.prisma.reelComment.updateMany({ where: { id: commentId, reelId, userId, status: "VISIBLE" }, data: { body, editedAt: this.clock.now() } });
    if (changed.count === 0) throw commentNotFound();
    return (await this.views([await this.prisma.reelComment.findUniqueOrThrow({ where: { id: commentId } })], userId))[0];
  }

  /** The author, or the creator of the reel, deletes. Repeating it is harmless (the counter moves only for the request that changed the row). */
  async remove(userId: string, reelId: string, commentId: string): Promise<void> {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || reel.status === "DELETED") throw reelNotFound();
    const comment = await this.prisma.reelComment.findFirst({ where: { id: commentId, reelId } });
    if (!comment) throw commentNotFound();
    if (comment.userId !== userId && reel.creatorId !== userId) throw new AppError("FORBIDDEN", 403, "Only the author of a comment or the creator of the reel can delete it");
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.reelComment.updateMany({ where: { id: commentId, status: "VISIBLE" }, data: { status: "DELETED", deletedAt: this.clock.now(), deletedBy: userId } });
      if (changed.count === 1) await bumpCounter(tx, reelId, "comments", -1);
    }, TX_OPTIONS);
  }

  /** Top-level comments, newest first: the visible ones, plus deleted ones that still have visible replies. */
  async list(reelId: string, viewerId: string | null, page: PageQuery): Promise<{ items: CommentView[]; nextCursor: string | null }> {
    await this.visibleReel(reelId, viewerId);
    const blocked = [...(await this.blocks.relations(viewerId)).blocked];
    const rows = await this.prisma.reelComment.findMany({
      where: {
        reelId,
        parentId: null,
        // Hidden and removed comments never show; neither do comments of people the viewer blocked or who blocked the viewer (a deleted placeholder stays while a visible reply remains).
        OR: [{ status: "VISIBLE", userId: { notIn: blocked } }, { status: "DELETED", replies: { some: { status: "VISIBLE", userId: { notIn: blocked } } } }],
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: await this.views(items, viewerId), nextCursor };
  }

  /** Visible replies of one top-level comment, oldest first. */
  async replies(reelId: string, commentId: string, viewerId: string | null, page: PageQuery): Promise<{ items: CommentView[]; nextCursor: string | null }> {
    await this.visibleReel(reelId, viewerId);
    const blocked = [...(await this.blocks.relations(viewerId)).blocked];
    const top = await this.prisma.reelComment.findFirst({ where: { id: commentId, reelId, parentId: null, status: { in: ["VISIBLE", "DELETED"] } } });
    if (!top || (top.status === "VISIBLE" && blocked.includes(top.userId))) throw commentNotFound();
    const rows = await this.prisma.reelComment.findMany({
      where: { reelId, parentId: commentId, status: "VISIBLE", userId: { notIn: blocked }, ...(page.cursor ? { id: { gt: page.cursor } } : {}) },
      orderBy: { id: "asc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: await this.views(items, viewerId), nextCursor };
  }

  private requireBody(raw: string): string {
    const body = sanitizePlainText(raw, COMMENT_MAX);
    if (body.length === 0) throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { body: ["must not be empty"] } });
    return body;
  }

  /** A reel the viewer may see (published, and neither side blocked the other); anything else does not exist for comments. */
  private async visibleReel(reelId: string, viewerId: string | null): Promise<Reel> {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || reel.status !== "PUBLISHED" || (await this.visibility.filterVisible(viewerId, { reelIds: [reelId] }, { mutes: false })).length === 0) throw reelNotFound();
    return reel;
  }

  private async views(rows: ReelComment[], viewerId: string | null): Promise<CommentView[]> {
    if (rows.length === 0) return [];
    const authorIds = [...new Set(rows.filter((r) => r.status === "VISIBLE").map((r) => r.userId))];
    let summaries = await this.profiles.summaries(authorIds);
    // The profile of a new member is created by the user.registered handler; a comment can beat it, so make sure it exists rather than show no author.
    const missing = authorIds.filter((id) => !summaries.has(id));
    if (missing.length > 0) {
      await Promise.all(missing.map((id) => this.profiles.ensure(id)));
      summaries = await this.profiles.summaries(authorIds);
    }
    const avatars = await this.media.publicUrls([...summaries.values()].flatMap((s) => (s.avatarAssetId ? [s.avatarAssetId] : [])));
    const blocked = [...(await this.blocks.relations(viewerId)).blocked];
    const topLevel = rows.filter((r) => r.parentId === null).map((r) => r.id);
    const counts = new Map(
      topLevel.length === 0 ? [] : (await this.prisma.reelComment.groupBy({ by: ["parentId"], where: { parentId: { in: topLevel }, status: "VISIBLE", userId: { notIn: blocked } }, _count: { _all: true } })).map((g) => [g.parentId, g._count._all] as const),
    );
    return rows.map((r) => {
      const visible = r.status === "VISIBLE";
      const summary = visible ? summaries.get(r.userId) : undefined;
      return {
        id: r.id,
        reelId: r.reelId,
        parentId: r.parentId,
        body: visible ? r.body : DELETED_COMMENT_BODY,
        status: visible ? "VISIBLE" : "DELETED",
        author: summary ? { id: summary.id, handle: summary.handle, displayName: summary.displayName, avatar: (summary.avatarAssetId ? avatars.get(summary.avatarAssetId) : undefined) ?? null } : null,
        replyCount: counts.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
        editedAt: r.editedAt?.toISOString() ?? null,
        ...(viewerId ? { mine: r.userId === viewerId } : {}),
      };
    });
  }
}
