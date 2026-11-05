/**
 * The "For you" score (plan Decision 6): explainable, no ML.
 *
 *   score = recency x engagement x (1 + interest match) x (0.2 if the viewer has seen the reel)
 *
 * recency    = 0.5 ^ (age / 24 h)
 * engagement = ENGAGEMENT_FLOOR + (likes + 2 comments + 3 saves + 2 shares) / max(views, 20)
 * interest   = sum of the viewer's normalised weights for the reel's tags ("tag:<tag>") and course category ("cat:<id>"), capped at 1
 *
 * The floor keeps a reel nobody has reacted to yet from scoring 0: without it every new reel would tie at zero and never surface.
 */
export const HALF_LIFE_HOURS = 24;
export const SEEN_FACTOR = 0.2;
export const MAX_PER_CREATOR = 2;
export const MIN_VIEWS_DENOMINATOR = 20;
export const ENGAGEMENT_FLOOR = 0.05;

export interface FeedReel {
  id: string;
  creatorId: string;
  publishedAt: Date;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  shareCount: number;
  viewCount: number;
  hashtags: string[];
  /** The category of the linked course, if any. */
  categoryId: string | null;
}

/** Interest keys to weights in 0..1 (the viewer's strongest interest is 1). */
export type InterestWeights = Map<string, number>;

export interface Ranked {
  id: string;
  creatorId: string;
  score: number;
}

export const recencyFactor = (ageMs: number): number => 0.5 ** (Math.max(0, ageMs) / (HALF_LIFE_HOURS * 3600_000));

export const engagementRate = (r: Pick<FeedReel, "likeCount" | "commentCount" | "saveCount" | "shareCount" | "viewCount">): number =>
  (r.likeCount + 2 * r.commentCount + 3 * r.saveCount + 2 * r.shareCount) / Math.max(r.viewCount, MIN_VIEWS_DENOMINATOR);

export function interestMatch(r: Pick<FeedReel, "hashtags" | "categoryId">, interests: InterestWeights): number {
  if (interests.size === 0) return 0;
  let sum = 0;
  for (const tag of r.hashtags) sum += interests.get(`tag:${tag}`) ?? 0;
  if (r.categoryId) sum += interests.get(`cat:${r.categoryId}`) ?? 0;
  return Math.min(1, sum);
}

/** Scales raw (already decayed) weights so the strongest interest is 1; non-positive weights drop out. */
export function normaliseInterests(rows: Array<{ key: string; weight: number }>): InterestWeights {
  const live = rows.filter((r) => r.weight > 0);
  const max = Math.max(0, ...live.map((r) => r.weight));
  return new Map(live.map((r) => [r.key, r.weight / max]));
}

export function scoreReel(r: FeedReel, now: Date, interests: InterestWeights, seen: boolean): number {
  const base = recencyFactor(now.getTime() - r.publishedAt.getTime()) * (ENGAGEMENT_FLOOR + engagementRate(r)) * (1 + interestMatch(r, interests));
  return seen ? base * SEEN_FACTOR : base;
}

/** Best first. Equal scores: newer first, then higher id, so the order never depends on input order. */
export function rankReels(reels: FeedReel[], now: Date, interests: InterestWeights, seen: Set<string>): Ranked[] {
  return reels
    .map((r) => ({ r, score: scoreReel(r, now, interests, seen.has(r.id)) }))
    .sort((a, b) => b.score - a.score || b.r.publishedAt.getTime() - a.r.publishedAt.getTime() || (a.r.id < b.r.id ? 1 : a.r.id > b.r.id ? -1 : 0))
    .map(({ r, score }) => ({ id: r.id, creatorId: r.creatorId, score }));
}

/**
 * Greedy pick, block by block: each block of `blockSize` takes the best remaining reels with at most MAX_PER_CREATOR from one creator; the
 * ones skipped stay at the head of what is left, so they come in the next block. If nobody else is left the cap is relaxed (a feed of one
 * creator still has to show something). Nothing is dropped or repeated.
 */
export function interleave<T extends { creatorId: string }>(ranked: T[], blockSize: number): T[] {
  const size = Math.max(1, blockSize);
  let remaining = ranked;
  const out: T[] = [];
  while (remaining.length > 0) {
    const counts = new Map<string, number>();
    const taken = new Set<number>();
    for (let i = 0; i < remaining.length && taken.size < size; i++) {
      const n = counts.get(remaining[i].creatorId) ?? 0;
      if (n < MAX_PER_CREATOR) {
        counts.set(remaining[i].creatorId, n + 1);
        taken.add(i);
      }
    }
    for (let i = 0; i < remaining.length && taken.size < size; i++) taken.add(i); // only capped-out creators are left
    out.push(...remaining.filter((_, i) => taken.has(i)));
    remaining = remaining.filter((_, i) => !taken.has(i));
  }
  return out;
}
