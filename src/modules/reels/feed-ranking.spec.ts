import { engagementRate, interestMatch, interleave, normaliseInterests, rankReels, recencyFactor, scoreReel, type FeedReel } from "./feed-ranking";

const NOW = new Date("2026-11-05T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const reel = (id: string, over: Partial<FeedReel> = {}): FeedReel => ({
  id,
  creatorId: `c-${id}`,
  publishedAt: hoursAgo(1),
  likeCount: 0,
  commentCount: 0,
  saveCount: 0,
  shareCount: 0,
  viewCount: 0,
  hashtags: [],
  categoryId: null,
  ...over,
});

describe("feed ranking (Decision 6)", () => {
  it("recency halves every 24 hours and never exceeds 1", () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(24 * 3600_000)).toBeCloseTo(0.5, 10);
    expect(recencyFactor(48 * 3600_000)).toBeCloseTo(0.25, 10);
    expect(recencyFactor(-5000)).toBe(1);
  });

  it("engagement rate is (likes + 2 comments + 3 saves + 2 shares) / max(views, 20)", () => {
    expect(engagementRate(reel("a", { likeCount: 10, commentCount: 5, saveCount: 2, shareCount: 1, viewCount: 100 }))).toBeCloseTo((10 + 10 + 6 + 2) / 100, 10);
    // Few views: the denominator floor keeps three early likes from looking like a hit.
    expect(engagementRate(reel("b", { likeCount: 3, viewCount: 3 }))).toBeCloseTo(3 / 20, 10);
  });

  it("interest match sums the weights of the reel's tags and category and caps at 1", () => {
    const interests = new Map([["tag:react", 0.6], ["tag:node", 0.3], ["cat:dev", 0.8]]);
    expect(interestMatch(reel("a", { hashtags: ["react"] }), interests)).toBeCloseTo(0.6, 10);
    expect(interestMatch(reel("a", { hashtags: ["react", "node"] }), interests)).toBeCloseTo(0.9, 10);
    expect(interestMatch(reel("a", { hashtags: ["react", "node"], categoryId: "dev" }), interests)).toBe(1);
    expect(interestMatch(reel("a", { hashtags: ["cooking"] }), interests)).toBe(0);
  });

  it("normalises interests to the strongest one", () => {
    const m = normaliseInterests([{ key: "tag:a", weight: 4 }, { key: "tag:b", weight: 1 }, { key: "tag:c", weight: 0 }]);
    expect([...m.entries()]).toEqual([["tag:a", 1], ["tag:b", 0.25]]);
    expect(normaliseInterests([]).size).toBe(0);
  });

  it("a reel nobody engaged with yet still ranks by recency (the engagement factor has a floor)", () => {
    const fresh = scoreReel(reel("a", { publishedAt: hoursAgo(1) }), NOW, new Map(), false);
    const old = scoreReel(reel("b", { publishedAt: hoursAgo(30) }), NOW, new Map(), false);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0);
  });

  it("an interest match multiplies by (1 + match); a seen reel is multiplied by 0.2", () => {
    const base = scoreReel(reel("a"), NOW, new Map(), false);
    expect(scoreReel(reel("a", { hashtags: ["x"] }), NOW, new Map([["tag:x", 1]]), false)).toBeCloseTo(base * 2, 10);
    expect(scoreReel(reel("a"), NOW, new Map(), true)).toBeCloseTo(base * 0.2, 10);
  });

  it("ranks high engagement over low at the same age, recent over old at the same engagement, and breaks ties by newest then id", () => {
    const ranked = rankReels(
      [
        reel("low", { likeCount: 1, viewCount: 100 }),
        reel("high", { likeCount: 50, viewCount: 100 }),
        reel("old-high", { likeCount: 50, viewCount: 100, publishedAt: hoursAgo(72) }),
        reel("tie-a", { publishedAt: hoursAgo(2) }),
        reel("tie-b", { publishedAt: hoursAgo(2) }),
      ],
      NOW,
      new Map(),
      new Set(),
    ).map((r) => r.id);
    expect(ranked.indexOf("high")).toBeLessThan(ranked.indexOf("low"));
    expect(ranked.indexOf("high")).toBeLessThan(ranked.indexOf("old-high"));
    expect(ranked.indexOf("tie-b")).toBeLessThan(ranked.indexOf("tie-a")); // same score and time: higher id first
  });
});

describe("interleave: at most 2 reels per creator in every block", () => {
  const ranked = (spec: string) => spec.split(" ").map((s, i) => ({ id: `${s}${i}`, creatorId: s }));
  const blocks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  it("pushes a creator's third reel of a block to a later block, keeping the order otherwise", () => {
    const out = interleave(ranked("a a a b c d e f"), 4);
    expect(out.map((r) => r.id)).toEqual(["a0", "a1", "b3", "c4", "a2", "d5", "e6", "f7"]);
    for (const block of blocks(out, 4)) expect(block.filter((r) => r.creatorId === "a").length).toBeLessThanOrEqual(2);
  });

  it("keeps every reel exactly once, and relaxes the cap only when nobody else is left", () => {
    const out = interleave(ranked("a a a a a b"), 3);
    expect(out.map((r) => r.id).sort()).toEqual(ranked("a a a a a b").map((r) => r.id).sort());
    expect(out.slice(0, 3).filter((r) => r.creatorId === "a").length).toBe(2);
    const only = interleave(ranked("a a a a"), 3);
    expect(only.length).toBe(4);
  });
});
