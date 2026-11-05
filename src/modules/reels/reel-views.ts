import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { Reel } from "@prisma/client";
import { CourseLookup } from "../courses";
import { GigLookup } from "../gigs";
import { MediaService } from "../media";
import { ProfilesService } from "../users";

export interface ReelCreatorView {
  id: string;
  handle: string | null;
  displayName: string | null;
  /** Avatar image URLs by size, or null. */
  avatar: Record<string, string> | null;
}

export interface ReelCourseView {
  id: string;
  slug: string;
  title: string;
  pricePaise: string;
  thumbnail: Record<string, string> | null;
}

export interface ReelGigView {
  id: string;
  slug: string;
  title: string;
  startingPricePaise: string | null;
  cover: Record<string, string> | null;
}

export interface ReelView {
  id: string;
  status: Reel["status"];
  caption: string;
  hashtags: string[];
  commentsEnabled: boolean;
  publishedAt: string | null;
  createdAt: string;
  /** Only the creator is told why a reel failed. */
  failureReason?: string | null;
  creator: ReelCreatorView;
  /** HLS playlist and poster once the video is ready; null before. */
  media: { hls: string; poster: string | null } | null;
  counts: { likes: number; comments: number; saves: number; shares: number; views: number };
  /** The linked course while it is still available (published, not flagged); null otherwise. */
  course: ReelCourseView | null;
  /** The linked gig while it is live (ACTIVE: not paused, held back, removed or deleted); null otherwise. */
  gig: ReelGigView | null;
  /** Present for signed-in viewers. */
  likedByMe?: boolean;
  savedByMe?: boolean;
}

/** Builds what clients see of reels, for a page of them at a time (a handful of queries however many reels). */
@Injectable()
export class ReelViews {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly media: MediaService,
    private readonly courses: CourseLookup,
    private readonly gigs: GigLookup,
  ) {}

  async build(reels: Reel[], viewerId: string | null): Promise<ReelView[]> {
    if (reels.length === 0) return [];
    const summaries = await this.profiles.summaries([...new Set(reels.map((r) => r.creatorId))]);
    const cards = await this.courses.availableCards([...new Set(reels.flatMap((r) => (r.linkedCourseId ? [r.linkedCourseId] : [])))]);
    const gigCards = await this.gigs.liveCards([...new Set(reels.flatMap((r) => (r.linkedGigId ? [r.linkedGigId] : [])))]);
    const assetIds = [
      ...reels.map((r) => r.mediaAssetId),
      ...[...summaries.values()].flatMap((s) => (s.avatarAssetId ? [s.avatarAssetId] : [])),
      ...[...cards.values()].flatMap((c) => (c.thumbnailAssetId ? [c.thumbnailAssetId] : [])),
      ...[...gigCards.values()].flatMap((g) => (g.coverAssetId ? [g.coverAssetId] : [])),
    ];
    const urls = await this.media.publicUrls(assetIds);
    const mine = await this.engagement(reels, viewerId);

    return reels.map((r) => {
      const summary = summaries.get(r.creatorId);
      const card = r.linkedCourseId ? cards.get(r.linkedCourseId) : undefined;
      const gigCard = r.linkedGigId ? gigCards.get(r.linkedGigId) : undefined;
      const video = urls.get(r.mediaAssetId);
      const isOwner = viewerId === r.creatorId;
      return {
        id: r.id,
        status: r.status,
        caption: r.caption,
        hashtags: r.hashtags,
        commentsEnabled: r.commentsEnabled,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        ...(isOwner ? { failureReason: r.failureReason } : {}),
        creator: {
          id: r.creatorId,
          handle: summary?.handle ?? null,
          displayName: summary?.displayName ?? null,
          avatar: (summary?.avatarAssetId ? urls.get(summary.avatarAssetId) : undefined) ?? null,
        },
        media: video?.hls ? { hls: video.hls, poster: video.poster ?? null } : null,
        counts: { likes: r.likeCount, comments: r.commentCount, saves: r.saveCount, shares: r.shareCount, views: r.viewCount },
        course: card ? { id: card.id, slug: card.slug, title: card.title, pricePaise: card.pricePaise, thumbnail: (card.thumbnailAssetId ? urls.get(card.thumbnailAssetId) : undefined) ?? null } : null,
        gig: gigCard ? { id: gigCard.id, slug: gigCard.slug, title: gigCard.title, startingPricePaise: gigCard.startingPricePaise, cover: (gigCard.coverAssetId ? urls.get(gigCard.coverAssetId) : undefined) ?? null } : null,
        ...(viewerId ? { likedByMe: mine.liked.has(r.id), savedByMe: mine.saved.has(r.id) } : {}),
      };
    });
  }

  /** Which of these reels the signed-in viewer liked and saved. */
  private async engagement(reels: Reel[], viewerId: string | null): Promise<{ liked: Set<string>; saved: Set<string> }> {
    if (!viewerId) return { liked: new Set(), saved: new Set() };
    const ids = reels.map((r) => r.id);
    const [likes, saves] = await Promise.all([
      this.prisma.reelLike.findMany({ where: { userId: viewerId, reelId: { in: ids } }, select: { reelId: true } }),
      this.prisma.reelSave.findMany({ where: { userId: viewerId, reelId: { in: ids } }, select: { reelId: true } }),
    ]);
    return { liked: new Set(likes.map((l) => l.reelId)), saved: new Set(saves.map((s) => s.reelId)) };
  }
}
