import { Injectable } from "@nestjs/common";
import type { Reel } from "@prisma/client";
import { CourseLookup } from "../courses";
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
  /** Present for signed-in viewers. */
  likedByMe?: boolean;
  savedByMe?: boolean;
}

/** Builds what clients see of reels, for a page of them at a time (a handful of queries however many reels). */
@Injectable()
export class ReelViews {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly media: MediaService,
    private readonly courses: CourseLookup,
  ) {}

  async build(reels: Reel[], viewerId: string | null): Promise<ReelView[]> {
    if (reels.length === 0) return [];
    const summaries = await this.profiles.summaries([...new Set(reels.map((r) => r.creatorId))]);
    const cards = await this.courses.availableCards([...new Set(reels.flatMap((r) => (r.linkedCourseId ? [r.linkedCourseId] : [])))]);
    const assetIds = [
      ...reels.map((r) => r.mediaAssetId),
      ...[...summaries.values()].flatMap((s) => (s.avatarAssetId ? [s.avatarAssetId] : [])),
      ...[...cards.values()].flatMap((c) => (c.thumbnailAssetId ? [c.thumbnailAssetId] : [])),
    ];
    const urls = await this.media.publicUrls(assetIds);

    return reels.map((r) => {
      const summary = summaries.get(r.creatorId);
      const card = r.linkedCourseId ? cards.get(r.linkedCourseId) : undefined;
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
      };
    });
  }
}
