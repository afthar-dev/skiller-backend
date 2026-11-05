import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Reel } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EntitlementsService } from "../billing";
import { GigLookup } from "../gigs";
import { CourseLookup, sanitizePlainText } from "../courses";
import { MediaAttachments } from "../media";
import { OpenReports, PostingRestrictions } from "../moderation";
import { ProfilesService } from "../users";
import { adjustHashtags } from "./hashtag-counts";
import { extractHashtags } from "./hashtags";
import { ReelPublisher } from "./reel-publisher";
import { ReelVisibility } from "./reel-visibility";
import { CAPTION_MAX, COUNTED_STATUS, courseNotLinkable, EDITABLE_STATUSES, gigNotLinkable, linkConflict, mediaNotUsable, reelNotFound, stateInvalid } from "./reel-rules";
import { ReelViews, type ReelView } from "./reel-views";

export interface CreateReelInput {
  mediaAssetId: string;
  caption: string;
  linkedCourseId?: string;
  linkedGigId?: string;
  commentsEnabled?: boolean;
}

export interface UpdateReelInput {
  caption?: string;
  linkedCourseId?: string | null;
  linkedGigId?: string | null;
  commentsEnabled?: boolean;
}

const PROFILE_REELS_CURSOR = "profile-reels";
const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

@Injectable()
export class ReelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: ReelPublisher,
    private readonly media: MediaAttachments,
    private readonly courses: CourseLookup,
    private readonly gigs: GigLookup,
    private readonly profiles: ProfilesService,
    private readonly entitlements: EntitlementsService,
    private readonly views: ReelViews,
    private readonly visibility: ReelVisibility,
    private readonly restrictions: PostingRestrictions,
    private readonly reports: OpenReports,
    private readonly cursors: SignedCursor,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts a reel from one of the creator's own REEL uploads. A video that is already READY is published at once (subject to the daily limit);
   * one that is still processing leaves a PROCESSING reel that the media.ready handler publishes. The video is reserved (attached) for the reel
   * in the same transaction as the reel, so the hourly orphan cleanup never takes it while it processes; a failed video is released again.
   */
  async create(userId: string, input: CreateReelInput): Promise<ReelView> {
    await this.restrictions.assertCanPost(userId);
    const info = await this.media.assetInfo(input.mediaAssetId);
    if (!info || info.ownerId !== userId || info.orgId !== null || info.purpose !== "REEL" || info.status === "FAILED" || info.status === "PENDING") throw mediaNotUsable();
    if (input.linkedCourseId && input.linkedGigId) throw linkConflict();
    if (input.linkedCourseId && !(await this.courses.isLinkableBy(input.linkedCourseId, userId))) throw courseNotLinkable();
    if (input.linkedGigId && !(await this.gigs.liveGigOf(input.linkedGigId, userId))) throw gigNotLinkable();
    const caption = sanitizePlainText(input.caption, CAPTION_MAX);

    let reel: Reel;
    try {
      reel = await this.prisma.$transaction(async (tx) => {
        await this.media.reserve(tx, input.mediaAssetId, userId, "REEL");
        return tx.reel.create({
          data: { creatorId: userId, mediaAssetId: input.mediaAssetId, caption, hashtags: extractHashtags(caption), linkedCourseId: input.linkedCourseId ?? null, linkedGigId: input.linkedGigId ?? null, commentsEnabled: input.commentsEnabled ?? true },
        });
      }, TX_OPTIONS);
    } catch (err) {
      if (isUniqueViolation(err)) throw mediaNotUsable(409);
      throw err;
    }
    return this.ownView((await this.publisher.publish(reel.id)).reel, userId);
  }

  /** The creator asks again: a LIMIT_REACHED reel after midnight IST, or a PROCESSING one whose ready event was missed. Still over the limit is a 403. */
  async publish(userId: string, reelId: string): Promise<ReelView> {
    await this.restrictions.assertCanPost(userId);
    const reel = await this.owned(userId, reelId);
    if (reel.status === "PUBLISHED") return this.ownView(reel, userId);
    if (reel.status !== "PROCESSING" && reel.status !== "LIMIT_REACHED") throw stateInvalid("This reel cannot be published");
    const result = await this.publisher.publish(reelId);
    if (result.outcome === "limit" || result.outcome === "limit_again") {
      const limit = await this.entitlements.limit({ ownerType: "USER", ownerId: userId }, "reels_per_day");
      throw new AppError("ENTITLEMENT_LIMIT_REACHED", 403, "Your plan's daily reel limit has been reached; try again after midnight IST or upgrade", { key: "reels_per_day", limit });
    }
    if (result.outcome === "restricted" || result.outcome === "restricted_again") await this.restrictions.assertCanPost(userId);
    return this.ownView(result.reel, userId);
  }

  async update(userId: string, reelId: string, patch: UpdateReelInput): Promise<ReelView> {
    // A ban covers what goes on live surfaces: new text and a new course link. Turning comments off is not posting.
    if (patch.caption !== undefined || patch.linkedCourseId !== undefined || patch.linkedGigId !== undefined) await this.restrictions.assertCanPost(userId);
    await this.owned(userId, reelId);
    if (patch.linkedCourseId && patch.linkedGigId) throw linkConflict();
    if (patch.linkedCourseId && !(await this.courses.isLinkableBy(patch.linkedCourseId, userId))) throw courseNotLinkable();
    if (patch.linkedGigId && !(await this.gigs.liveGigOf(patch.linkedGigId, userId))) throw gigNotLinkable();
    const caption = patch.caption === undefined ? undefined : sanitizePlainText(patch.caption, CAPTION_MAX);

    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "reels" WHERE "id" = ${reelId} FOR UPDATE`;
      const status = rows[0]?.status;
      if (!status || status === "DELETED") throw reelNotFound();
      if (!EDITABLE_STATUSES.includes(status)) throw stateInvalid("This reel can no longer be edited");
      const current = await tx.reel.findUniqueOrThrow({ where: { id: reelId } });
      const data: Prisma.ReelUpdateInput = {};
      if (caption !== undefined) {
        data.caption = caption;
        data.hashtags = extractHashtags(caption);
      }
      if (patch.linkedCourseId !== undefined) data.linkedCourseId = patch.linkedCourseId;
      if (patch.linkedGigId !== undefined) data.linkedGigId = patch.linkedGigId;
      // One link at a time: the result must not carry both (setting one while the other stays is refused; clear it in the same request).
      if ((patch.linkedCourseId !== undefined ? patch.linkedCourseId : current.linkedCourseId) && (patch.linkedGigId !== undefined ? patch.linkedGigId : current.linkedGigId)) throw linkConflict();
      if (patch.commentsEnabled !== undefined) data.commentsEnabled = patch.commentsEnabled;
      const row = await tx.reel.update({ where: { id: reelId }, data });
      if (status === COUNTED_STATUS && caption !== undefined) {
        const before = new Set(current.hashtags);
        const after = new Set(row.hashtags);
        await adjustHashtags(tx, { add: row.hashtags.filter((t) => !before.has(t)), remove: current.hashtags.filter((t) => !after.has(t)) }, this.clock.now());
      }
      return row;
    }, TX_OPTIONS);
    return this.ownView(updated, userId);
  }

  /**
   * Soft delete: the row stays (the daily limit counts publish events) and the hashtag counts drop. The video is released for cleanup, unless the reel has
   * open reports: it stays attached as evidence until a moderator decides (an upheld report purges it, a dismissed one releases it). Deleting twice is harmless.
   */
  async remove(userId: string, reelId: string): Promise<void> {
    await this.owned(userId, reelId, true);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "reels" WHERE "id" = ${reelId} FOR UPDATE`;
      if (!rows[0] || rows[0].status === "DELETED") return;
      const reel = await tx.reel.update({ where: { id: reelId }, data: { status: "DELETED", deletedAt: this.clock.now() } });
      if (rows[0].status === COUNTED_STATUS) await adjustHashtags(tx, { remove: reel.hashtags }, this.clock.now());
      if (!(await this.reports.exist(tx, "REEL", reelId))) await this.media.detach(tx, reel.mediaAssetId);
    }, TX_OPTIONS);
  }

  /**
   * A published reel for any viewer who has not blocked, or been blocked by, its creator; its creator also sees it in any state but deleted
   * (a hidden or removed reel shows its status in the studio). Everyone else gets 404.
   */
  async get(reelId: string, viewerId: string | null): Promise<ReelView> {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    const isOwner = !!reel && viewerId === reel.creatorId;
    if (!reel || (isOwner ? reel.status === "DELETED" : reel.status !== "PUBLISHED" || (await this.visibility.filterVisible(viewerId, { reelIds: [reelId] }, { mutes: false })).length === 0)) throw reelNotFound();
    return (await this.views.build([reel], viewerId))[0];
  }

  /** A creator's published reels, newest first (by publish time). */
  async byHandle(handle: string, page: PageQuery, viewerId: string | null): Promise<{ items: ReelView[]; nextCursor: string | null }> {
    const profile = await this.profiles.getByHandle(handle);
    // Blocked either way: the profile tab is empty for this viewer.
    if ((await this.visibility.filterVisible(viewerId, { creatorIds: [profile.userId] }, { mutes: false })).length === 0) return { items: [], nextCursor: null };
    let after: { t: Date; id: string } | undefined;
    if (page.cursor) {
      const c = this.cursors.verify(PROFILE_REELS_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      after = { t, id: c.id };
    }
    const rows = await this.prisma.reel.findMany({
      where: {
        creatorId: profile.userId,
        status: "PUBLISHED",
        ...(after ? { OR: [{ publishedAt: { lt: after.t } }, { publishedAt: after.t, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > page.limit && last?.publishedAt ? this.cursors.sign(PROFILE_REELS_CURSOR, { t: last.publishedAt.toISOString(), id: last.id }) : null;
    return { items: await this.views.build(items, viewerId), nextCursor };
  }

  /** The creator's own reel (404 for anyone else's, and for a deleted one unless `includeDeleted`). */
  private async owned(userId: string, reelId: string, includeDeleted = false): Promise<Reel> {
    const reel = await this.prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || reel.creatorId !== userId || (reel.status === "DELETED" && !includeDeleted)) throw reelNotFound();
    return reel;
  }

  private async ownView(reel: Reel, userId: string): Promise<ReelView> {
    return (await this.views.build([reel], userId))[0];
  }
}
