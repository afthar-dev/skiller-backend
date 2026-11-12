/**
 * Response shapes of the reel, feed, hashtag, reel search, reel studio analytics, report and notification routes. Each one is what the handler really
 * returns (ReelViews, CommentsService, EngagementService, ReelAnalyticsService, NotificationsService, ModerationService); the e2e specs check live
 * responses against them. `buildOpenApiDocument` merges `reelComponents` into `components.schemas`; routes name them with `ApiResult` / `ApiPageResult`.
 */
import { MONEY_PATTERN } from "./money";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: "string" } as const;
const nullableStr = { type: "string", nullable: true } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const num = { type: "number" } as const;
const date = { type: "string", format: "date-time" } as const;
const nullableDate = { type: "string", format: "date-time", nullable: true } as const;
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", required, properties });
const urlSet = { type: "object", nullable: true, additionalProperties: str } as const;
const range = obj({ from: { ...str, example: "2026-11-01" }, to: { ...str, example: "2026-11-30" } });
const live = obj({ likes: int, comments: int, saves: int, shares: int });

export const reelComponents: Record<string, unknown> = {
  ReelCreator: obj({ id: str, handle: nullableStr, displayName: nullableStr, avatar: { ...urlSet, description: "Avatar image URLs by size; null when there is none." } }),
  ReelCourse: obj({ id: str, slug: str, title: str, pricePaise: ref("Money"), thumbnail: { ...urlSet, description: "Thumbnail URLs by size; null when there is none." } }),
  ReelGig: obj({ id: str, slug: str, title: str, startingPricePaise: { type: "string", pattern: MONEY_PATTERN, nullable: true, description: "Money: integer paise as a string; null when the gig has no package price." }, cover: { ...urlSet, description: "Cover image URLs by size; null when there is none." } }),
  Reel: obj(
    {
      id: str,
      status: { type: "string", enum: ["PROCESSING", "PUBLISHED", "HIDDEN", "REMOVED", "DELETED", "FAILED", "LIMIT_REACHED"] },
      caption: str,
      hashtags: { type: "array", items: str },
      commentsEnabled: bool,
      publishedAt: nullableDate,
      createdAt: date,
      failureReason: { ...nullableStr, description: "Only the creator is told why a reel failed or is waiting." },
      creator: ref("ReelCreator"),
      media: { type: "object", nullable: true, required: ["hls", "poster"], properties: { hls: str, poster: nullableStr }, description: "HLS playlist and poster once the video is ready; null before." },
      counts: obj({ likes: int, comments: int, saves: int, shares: int, views: int }),
      course: { allOf: [ref("ReelCourse")], nullable: true, description: "The linked course while it is still available; null otherwise." },
      gig: { allOf: [ref("ReelGig")], nullable: true, description: "The linked gig while it is live; null otherwise." },
      likedByMe: { ...bool, description: "Present for signed-in viewers." },
      savedByMe: { ...bool, description: "Present for signed-in viewers." },
    },
    ["id", "status", "caption", "hashtags", "commentsEnabled", "publishedAt", "createdAt", "creator", "media", "counts", "course", "gig"],
  ),
  ForYouFeed: obj({ items: { type: "array", items: ref("Reel") }, nextCursor: nullableStr, refreshed: { ...bool, description: "True when the session in the cursor had expired and this page starts a new ranking." } }),
  HashtagReels: obj({ tag: str, reelCount: { ...int, description: "Published reels that carry the tag." }, items: { type: "array", items: ref("Reel") }, nextCursor: nullableStr }),
  TrendingHashtags: obj({
    computedAt: date,
    items: { type: "array", items: obj({ tag: str, uses: { ...int, description: "Reels that used the tag in the last 24 hours." }, previousUses: { ...int, description: "The same for the 24 hours before." } }) },
  }),
  ReelComment: obj(
    {
      id: str,
      reelId: str,
      parentId: { ...nullableStr, description: "The top-level comment this replies to; null for a top-level comment." },
      body: { ...str, description: "\"[deleted]\" for a deleted comment that stays because it has replies." },
      status: { type: "string", enum: ["VISIBLE", "DELETED"] },
      author: { type: "object", nullable: true, required: ["id", "handle", "displayName", "avatar"], properties: { id: str, handle: str, displayName: str, avatar: urlSet }, description: "Null for a deleted comment." },
      replyCount: int,
      createdAt: date,
      editedAt: nullableDate,
      mine: { ...bool, description: "Present for signed-in viewers: the comment is theirs." },
    },
    ["id", "reelId", "parentId", "body", "status", "author", "replyCount", "createdAt", "editedAt"],
  ),
  ReelLikeState: obj({ liked: bool, likeCount: int }),
  ReelSaveState: obj({ saved: bool, saveCount: int }),
  ReelShareResult: obj({ counted: bool, shareCount: int }),
  BeaconResult: obj({ counted: { ...bool, description: "Whether this beacon counted (once per viewer per reel per IST day)." } }),
  ReelAnalyticsTotals: obj({
    views: int,
    uniqueViewers: { ...int, description: "Approximate: summed per reel per day." },
    watchSec: int,
    avgWatchPct: { ...num, description: "0..100, one decimal." },
    linkClicks: int,
    newFollowers: int,
  }),
  ReelAnalyticsDaily: obj({ date: str, views: int, watchSec: int, linkClicks: int }),
  CreatorReelAnalytics: obj(
    {
      range,
      totals: ref("ReelAnalyticsTotals"),
      live: { ...live, description: "Current counters of the published reels (not limited to the range)." },
      upgradeRequired: { ...bool, description: "True on the basic plan, which gets totals only." },
      daily: { type: "array", items: ref("ReelAnalyticsDaily"), description: "Standard and advanced plans only." },
      topReels: {
        type: "array",
        description: "Standard and advanced plans only.",
        items: obj({ reelId: str, caption: str, status: str, views: int, uniqueViewers: int, avgWatchPct: num, linkClicks: int, likes: int, comments: int, saves: int, shares: int }),
      },
    },
    ["range", "totals", "live", "upgradeRequired"],
  ),
  SingleReelAnalytics: obj(
    {
      reelId: str,
      range,
      totals: ref("ReelAnalyticsTotals"),
      newFollowersScope: { type: "string", enum: ["creator"], description: "`totals.newFollowers` is the creator's, not attributed to this reel." },
      live,
      upgradeRequired: bool,
      daily: { type: "array", items: ref("ReelAnalyticsDaily"), description: "Standard and advanced plans only." },
    },
    ["reelId", "range", "totals", "newFollowersScope", "live", "upgradeRequired"],
  ),
  Notification: obj({ id: str, type: str, title: str, body: str, link: nullableStr, data: { type: "object", nullable: true, additionalProperties: true }, readAt: nullableDate, createdAt: date }),
  UnreadCount: obj({ count: int }),
  NotificationsMarkedRead: obj({ updated: int }),
  ReportReceipt: obj({ id: str, reported: bool }),
};
