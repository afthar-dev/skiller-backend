import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { HashtagTrending, TRENDING_KEY } from "../../src/modules/reels/hashtag-trending";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const HOUR = 3600_000;

describe("hashtags, trending and reel search", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  let trending: HashtagTrending;
  const http = () => request(t.app.getHttpServer());
  const get = (path: string, ip = uniqueIp()) => http().get(path).set("X-Forwarded-For", ip);
  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);
  const ago = (ms: number) => new Date(t.clock.now().getTime() - ms);

  interface ReelOpts {
    caption?: string;
    hashtags?: string[];
    publishedAt?: Date;
    status?: "PUBLISHED" | "HIDDEN";
    likeCount?: number;
    commentCount?: number;
    saveCount?: number;
    shareCount?: number;
  }
  async function reel(creatorId: string, o: ReelOpts = {}) {
    const a = await prisma.mediaAsset.create({
      data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() },
    });
    const status = o.status ?? "PUBLISHED";
    return prisma.reel.create({
      data: {
        creatorId,
        mediaAssetId: a.id,
        caption: o.caption ?? (o.hashtags ?? []).map((h) => `#${h}`).join(" "),
        hashtags: o.hashtags ?? [],
        status,
        likeCount: o.likeCount ?? 0,
        commentCount: o.commentCount ?? 0,
        saveCount: o.saveCount ?? 0,
        shareCount: o.shareCount ?? 0,
        publishedAt: status === "PUBLISHED" ? (o.publishedAt ?? ago(60_000)) : null,
      },
    });
  }
  /** Walks a paged URL to the end; returns the ids page by page. */
  async function walk(path: string, limit: number) {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      pages.push(ids(res.body));
      cursor = res.body.nextCursor;
      if (pages.length > 50) throw new Error("does not end");
    } while (cursor);
    return pages;
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
    trending = t.app.get(HashtagTrending);
  });
  afterAll(() => t?.close());

  describe("hashtag pages", () => {
    it("lists a tag's published reels newest first in keyset pages, ties by id, without hidden ones", async () => {
      const owner = await t.login();
      const tag = `rcnt${uniq()}`;
      const base = t.clock.now().getTime() - 3 * HOUR;
      const made: string[] = [];
      for (let i = 0; i < 6; i++) made.push((await reel(owner.userId, { hashtags: [tag, "extra"], publishedAt: new Date(base + i * 1000) })).id);
      await reel(owner.userId, { hashtags: [tag], status: "HIDDEN" });
      await reel(owner.userId, { hashtags: [`${tag}x`] }); // a different tag
      const same = new Date(base + 50_000);
      const tie = [(await reel(owner.userId, { hashtags: [tag], publishedAt: same })).id, (await reel(owner.userId, { hashtags: [tag], publishedAt: same })).id].sort().reverse();

      const first = await get(`/v1/hashtags/${tag}/reels?sort=recent&limit=3`);
      expect(first.body).toMatchObject({ tag, reelCount: 0 }); // rows written directly: the counter table is the posting path's business
      const pages = await walk(`/v1/hashtags/${tag}/reels?sort=recent`, 3);
      expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
      expect(pages.flat()).toEqual([...tie, ...made.slice().reverse()]);
    });

    it("takes the tag in any case, with or without #, and refuses what is not a tag", async () => {
      const owner = await t.login();
      const tag = `case${uniq()}`;
      const r = await reel(owner.userId, { hashtags: [tag] });
      for (const form of [tag, tag.toUpperCase(), `%23${tag}`, `%23${tag.toUpperCase()}`]) {
        const res = await get(`/v1/hashtags/${form}/reels?sort=recent`);
        expect([res.status, res.body.tag, ids(res.body)]).toEqual([200, tag, [r.id]]);
      }
      for (const bad of ["bad%20tag", "a-b", "%23%23x", "x".repeat(51), "%00", "%F0%9F%98%80", "a.b"]) {
        const res = await get(`/v1/hashtags/${bad}/reels`);
        expect([bad, res.status, res.body.error?.code]).toEqual([bad, 400, expect.stringMatching(/HASHTAG_INVALID|VALIDATION/)]);
      }
      const unknown = await get(`/v1/hashtags/nobody${uniq()}/reels`);
      expect(unknown.body).toMatchObject({ reelCount: 0, items: [], nextCursor: null });
      expect((await get(`/v1/hashtags/${tag}/reels?sort=hot`)).status).toBe(400);
    });

    it("ranks `top` by likes + 2 comments + 3 saves + 2 shares, ties by id, and pages without duplicates", async () => {
      const owner = await t.login();
      const tag = `top${uniq()}`;
      const a = await reel(owner.userId, { hashtags: [tag], likeCount: 10 }); // 10
      const b = await reel(owner.userId, { hashtags: [tag], commentCount: 4, saveCount: 1 }); // 8 + 3 = 11
      const c = await reel(owner.userId, { hashtags: [tag], shareCount: 3, likeCount: 1 }); // 6 + 1 = 7
      const d = await reel(owner.userId, { hashtags: [tag], saveCount: 5 }); // 15
      const e1 = await reel(owner.userId, { hashtags: [tag] }); // 0
      const e2 = await reel(owner.userId, { hashtags: [tag] }); // 0
      await reel(owner.userId, { hashtags: [tag], status: "HIDDEN", likeCount: 999 });
      const expected = [d.id, b.id, a.id, c.id, ...[e1.id, e2.id].sort().reverse()];

      const dflt = await get(`/v1/hashtags/${tag}/reels`); // top is the default
      expect(ids(dflt.body)).toEqual(expected);
      for (const size of [1, 2, 4]) expect((await walk(`/v1/hashtags/${tag}/reels?sort=top`, size)).flat()).toEqual(expected);
    });

    it("does not accept a cursor from another tag or sort, or a forged one", async () => {
      const owner = await t.login();
      const [t1, t2] = [`cur${uniq()}`, `cur${uniq()}`];
      for (let i = 0; i < 3; i++) await reel(owner.userId, { hashtags: [t1, t2] });
      const page = await get(`/v1/hashtags/${t1}/reels?sort=recent&limit=1`);
      const cursor = encodeURIComponent(page.body.nextCursor);
      expect((await get(`/v1/hashtags/${t2}/reels?sort=recent&cursor=${cursor}`)).body.error.code).toBe("BAD_CURSOR");
      expect((await get(`/v1/hashtags/${t1}/reels?sort=top&cursor=${cursor}`)).body.error.code).toBe("BAD_CURSOR");
      expect((await get(`/v1/hashtags/${t1}/reels?sort=recent&cursor=junk`)).body.error.code).toBe("BAD_CURSOR");
      expect((await get(`/v1/hashtags/${t1}/reels?sort=recent&cursor=${cursor}`)).status).toBe(200);
    });

    it("uses the GIN index on hashtags", async () => {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return tx.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN SELECT "id" FROM "reels" WHERE "hashtags" @> ARRAY['x']::text[]`);
      });
      expect(plan.map((r) => Object.values(r)[0]).join("\n")).toContain("reels_hashtags_idx");
    });
  });

  describe("trending", () => {
    it("ranks tags by growth of use over the previous 24 hours, counts only published reels, and returns at most 20", async () => {
      const owner = await t.login();
      const [hot, steady, fading, brandNew, hiddenOnly] = ["hot", "steady", "fading", "new", "hid"].map((n) => `${n}${uniq()}`);
      const now = (h: number) => ago(h * HOUR);
      for (let i = 0; i < 6; i++) await reel(owner.userId, { hashtags: [hot], publishedAt: now(1 + i) }); // 6 now, 0 before
      for (let i = 0; i < 3; i++) await reel(owner.userId, { hashtags: [steady], publishedAt: now(2 + i) });
      for (let i = 0; i < 3; i++) await reel(owner.userId, { hashtags: [steady], publishedAt: now(30 + i) }); // 3 now, 3 before
      await reel(owner.userId, { hashtags: [fading], publishedAt: now(3) });
      for (let i = 0; i < 4; i++) await reel(owner.userId, { hashtags: [fading], publishedAt: now(26 + i) }); // 1 now, 4 before
      await reel(owner.userId, { hashtags: [brandNew], publishedAt: now(0.5) }); // 1 now, 0 before
      for (let i = 0; i < 5; i++) await reel(owner.userId, { hashtags: [hiddenOnly], status: "HIDDEN" });
      await reel(owner.userId, { hashtags: [`old${uniq()}`], publishedAt: now(60) }); // outside both windows

      const list = await trending.refresh();
      expect(list.items.length).toBeLessThanOrEqual(20);
      const mine = list.items.filter((i) => [hot, steady, fading, brandNew, hiddenOnly].includes(i.tag));
      // hot: +6, new: +1, steady: 0 (3 vs 3), fading: -3 -> the last three only appear if the list has room
      expect(mine.map((i) => i.tag).slice(0, 2)).toEqual([hot, brandNew]);
      expect(mine.find((i) => i.tag === hot)).toEqual({ tag: hot, uses: 6, previousUses: 0 });
      expect(mine.find((i) => i.tag === hiddenOnly)).toBeUndefined();
      for (let i = 1; i < list.items.length; i++) {
        const [p, q] = [list.items[i - 1], list.items[i]];
        expect(p.uses - p.previousUses).toBeGreaterThanOrEqual(q.uses - q.previousUses);
      }
    });

    it("serves the stored list over HTTP (hourly job), computing it only when there is none", async () => {
      const owner = await t.login();
      const tag = `trend${uniq()}`;
      for (let i = 0; i < 30; i++) await reel(owner.userId, { hashtags: [tag], publishedAt: ago((1 + (i % 5)) * HOUR) });
      await redis.del(TRENDING_KEY);
      const first = await get("/v1/hashtags/trending");
      expect(first.status).toBe(200);
      expect(first.body.items[0]).toMatchObject({ tag, uses: 30, previousUses: 0 }); // 30 uses beat anything else any suite has made
      expect(first.body.items.length).toBeLessThanOrEqual(20);
      expect(await redis.ttl(TRENDING_KEY)).toBeGreaterThan(0);

      const late = `late${uniq()}`;
      for (let i = 0; i < 40; i++) await reel(owner.userId, { hashtags: [late] });
      expect((await get("/v1/hashtags/trending")).body).toEqual(first.body); // cached: unchanged until the job runs
      await trending.refresh();
      expect((await get("/v1/hashtags/trending")).body.items[0].tag).toBe(late);
    });
  });

  describe("reel search", () => {
    it("finds reels by caption word and by hashtag, case-insensitively, all words required, newest first", async () => {
      const owner = await t.login();
      const k = uniq();
      const r1 = await reel(owner.userId, { caption: `Learning Rust ${k} in a weekend #beginner`, hashtags: ["beginner"], publishedAt: ago(3 * HOUR) });
      const r2 = await reel(owner.userId, { caption: `${k} tips for async Rust`, hashtags: [], publishedAt: ago(2 * HOUR) });
      const r3 = await reel(owner.userId, { caption: `just a cat ${k} #tagged${k}`, hashtags: [`tagged${k}`], publishedAt: ago(1 * HOUR) });
      await reel(owner.userId, { caption: `rust ${k} hidden`, status: "HIDDEN" });

      expect(ids((await get(`/v1/reels/search?q=${k}`)).body)).toEqual([r3.id, r2.id, r1.id]);
      expect(ids((await get(`/v1/reels/search?q=RUST%20${k}`)).body)).toEqual([r2.id, r1.id]);
      expect(ids((await get(`/v1/reels/search?q=%23tagged${k}`)).body)).toEqual([r3.id]);
      expect(ids((await get(`/v1/reels/search?q=tagged${k}`)).body)).toEqual([r3.id]); // the hashtag is searchable without the #
      expect(ids((await get(`/v1/reels/search?q=${k}%20-rust`)).body)).toEqual([r3.id]); // websearch syntax: minus excludes
      expect(ids((await get(`/v1/reels/search?q=%22async%20rust%22%20${k}`)).body)).toEqual([r2.id]);
      const pages = await walk(`/v1/reels/search?q=${k}`, 1);
      expect(pages.flat()).toEqual([r3.id, r2.id, r1.id]);
    });

    it("reflects an edited caption at once, and drops a reel that is hidden or deleted", async () => {
      const owner = await t.login();
      const [a, b] = [uniq(), uniq()];
      const r = await reel(owner.userId, { caption: `alpha ${a}`, hashtags: [] });
      expect(ids((await get(`/v1/reels/search?q=${a}`)).body)).toEqual([r.id]);
      await prisma.reel.update({ where: { id: r.id }, data: { caption: `beta ${b} #moved${b}`, hashtags: [`moved${b}`] } });
      expect(ids((await get(`/v1/reels/search?q=${a}`)).body)).toEqual([]);
      expect(ids((await get(`/v1/reels/search?q=${b}`)).body)).toEqual([r.id]);
      expect(ids((await get(`/v1/reels/search?q=moved${b}`)).body)).toEqual([r.id]);
      await prisma.reel.update({ where: { id: r.id }, data: { status: "HIDDEN" } });
      expect(ids((await get(`/v1/reels/search?q=${b}`)).body)).toEqual([]);
    });

    it("falls back to fuzzy matching on the caption when no word matches (typos, half-typed words)", async () => {
      const owner = await t.login();
      const k = uniq();
      const r = await reel(owner.userId, { caption: `quantumcomputing${k} explained in sixty seconds` });
      expect(ids((await get(`/v1/reels/search?q=quantumcomputng${k}`)).body)).toEqual([r.id]); // a typo
      expect(ids((await get(`/v1/reels/search?q=quantumcomput`)).body)).toEqual(expect.any(Array));
      expect(ids((await get(`/v1/reels/search?q=zzzqqqxxxwww`)).body)).toEqual([]);
      const pages = await walk(`/v1/reels/search?q=quantumcomputng${k}`, 1);
      expect(pages.flat()).toEqual([r.id]);
    });

    it("never fails on odd input: operators, quotes, unicode, huge or repeated parameters, nothing", async () => {
      const odd = [
        "",
        "   ",
        "'",
        '"',
        '"unterminated',
        "a & b | !c",
        "(((",
        ":*",
        "\\",
        "%",
        "_",
        "-",
        "--",
        "OR",
        "#",
        "##",
        "a".repeat(5000),
        "😀😀😀",
        "नमस्ते",
        "‮́",
        "'; DROP TABLE reels; --",
        "<script>alert(1)</script>",
        "a\tb\nc",
      ];
      for (const q of odd) {
        const res = await get(`/v1/reels/search?q=${encodeURIComponent(q)}`);
        expect([q.slice(0, 20), res.status]).toEqual([q.slice(0, 20), 200]);
        expect(res.body).toMatchObject({ items: expect.any(Array) });
      }
      for (const raw of ["", "?q=a&q=b", "?q[x]=1", "?q[]=1&q[]=2", "?limit=abc", "?q=x&cursor=junk", "?q=x&limit=-5", "?q=x&limit=999999"]) {
        const res = await get(`/v1/reels/search${raw}`);
        expect([raw, res.status < 500]).toEqual([raw, true]);
      }
      expect((await get("/v1/reels/search")).body).toEqual({ items: [], nextCursor: null });
    });

    it("binds a cursor to its search text", async () => {
      const owner = await t.login();
      const k = uniq();
      for (let i = 0; i < 3; i++) await reel(owner.userId, { caption: `cursor ${k}` });
      const page = await get(`/v1/reels/search?q=${k}&limit=1`);
      const cursor = encodeURIComponent(page.body.nextCursor);
      expect((await get(`/v1/reels/search?q=other${k}&cursor=${cursor}`)).body.error.code).toBe("BAD_CURSOR");
      expect((await get(`/v1/reels/search?q=${k}&cursor=${cursor}`)).status).toBe(200);
    });

    it("`/reels/search` is not taken for a reel id, and the indexes carry the queries", async () => {
      const res = await get("/v1/reels/search?q=anything");
      expect(res.status).toBe(200);
      const explain = async (sql: string) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
          await tx.$executeRawUnsafe("SET LOCAL pg_trgm.word_similarity_threshold = 0.4");
          return (await tx.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN ${sql}`)).map((r) => Object.values(r)[0]).join("\n");
        });
      expect(await explain(`SELECT "id" FROM "reels" r WHERE r."searchVector" @@ websearch_to_tsquery('simple', 'x')`)).toContain("reels_search_vector_idx");
      expect(await explain(`SELECT "id" FROM "reels" r WHERE 'x'::text <% r."caption"`)).toContain("reels_caption_trgm_idx");
      const opts = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE indexname IN ('reels_search_vector_idx', 'reels_caption_trgm_idx')`;
      expect(opts.every((o) => /fastupdate='?off/.test(o.indexdef))).toBe(true);
      expect(opts).toHaveLength(2);
    });

    it("limits anonymous reads per address", async () => {
      const ip = uniqueIp();
      let last = 200;
      for (let i = 0; i < 301; i++) last = (await get("/v1/hashtags/trending", ip)).status;
      expect(last).toBe(429);
    });
  });
});
