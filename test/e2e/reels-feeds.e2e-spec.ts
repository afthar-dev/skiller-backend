import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EventBus } from "../../src/common/outbox/event-bus";
import { REDIS } from "../../src/common/redis";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { ProfilesService } from "../../src/modules/users";
import { FeedsService } from "../../src/modules/reels/feeds.service";
import { InterestsService } from "../../src/modules/reels/interests.service";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
type Kind = "like" | "save" | "comment" | "share" | "view";
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const DAY = 24 * 3600_000;

describe("reel feeds and interests", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  let bus: EventBus;
  let interests: InterestsService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  interface ReelOpts {
    hashtags?: string[];
    publishedAt?: Date;
    status?: "PUBLISHED" | "HIDDEN" | "PROCESSING";
    likeCount?: number;
    viewCount?: number;
    linkedCourseId?: string;
  }
  /** A reel written straight to the database (feeds only read it); published a minute ago unless told otherwise. */
  async function reel(creatorId: string, o: ReelOpts = {}) {
    const a = await prisma.mediaAsset.create({
      data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() },
    });
    const status = o.status ?? "PUBLISHED";
    return prisma.reel.create({
      data: {
        creatorId,
        mediaAssetId: a.id,
        caption: o.hashtags?.map((h) => `#${h}`).join(" ") ?? "",
        hashtags: o.hashtags ?? [],
        status,
        linkedCourseId: o.linkedCourseId ?? null,
        likeCount: o.likeCount ?? 0,
        viewCount: o.viewCount ?? 0,
        publishedAt: status === "PUBLISHED" ? (o.publishedAt ?? new Date(t.clock.now().getTime() - 60_000)) : null,
      },
    });
  }
  /** Follow rows reference profiles, which a login creates only once the registration event is relayed: make both now. */
  async function follow(follower: Session, followee: Session) {
    const profiles = t.app.get(ProfilesService);
    await Promise.all([profiles.ensure(follower.userId), profiles.ensure(followee.userId)]);
    await prisma.follow.createMany({ data: [{ followerId: follower.userId, followeeId: followee.userId }], skipDuplicates: true });
  }
  const following = (s: Session, qs = "") => http().get(`/v1/feed/following${qs}`).set(auth(s));
  const forYou = (s: Session | null, qs = "", ip = uniqueIp()) => {
    const req = http().get(`/v1/feed/for-you${qs}`).set("X-Forwarded-For", ip);
    return s ? req.set(auth(s)) : req;
  };
  const cur = (c: string) => encodeURIComponent(c);
  interface FeedBody {
    items: Array<{ id: string }>;
    nextCursor: string | null;
    refreshed?: boolean;
  }
  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);
  const creators = (n: number) => Promise.all(Array.from({ length: n }, () => t.login()));

  /** Follows nextCursor to the end; returns the pages' ids. */
  async function walk(first: () => request.Test, next: (cursor: string) => request.Test, onPage?: (page: number, body: FeedBody) => Promise<void> | void) {
    const pages: string[][] = [];
    let res = await first();
    expect(res.status).toBe(200);
    for (let p = 0; ; p++) {
      pages.push(ids(res.body));
      if (onPage) await onPage(p, res.body);
      if (!res.body.nextCursor) break;
      res = await next(res.body.nextCursor);
      expect(res.status).toBe(200);
      if (pages.length > 100) throw new Error("feed does not end");
    }
    return pages;
  }
  const walkForYou = (s: Session | null, limit: number, onPage?: (page: number, body: FeedBody) => Promise<void> | void) =>
    walk(() => forYou(s, `?limit=${limit}`), (c) => forYou(s, `?limit=${limit}&cursor=${cur(c)}`), onPage);
  const sessionOf = (cursor: string): string => JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString()).s;
  /** The one stored For you list of a signed-in viewer. */
  const snapshot = async (userId: string): Promise<{ g: string; ids: string[] }> => JSON.parse((await redis.get(`foryou:u:${userId}`))!);
  const foryouKeys = () => redis.keys("foryou:*");
  const dup = (list: string[]) => list.length - new Set(list).size;

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
    bus = t.app.get(EventBus);
    interests = t.app.get(InterestsService);
  });
  afterAll(() => t?.close());

  describe("following feed", () => {
    it("shows published reels of followed creators only, newest first, in keyset pages with no duplicates or skips", async () => {
      const me = await t.login();
      const [a, b, stranger] = await creators(3);
      await follow(me, a);
      await follow(me, b);
      const base = t.clock.now().getTime() - 3600_000;
      const made: string[] = [];
      for (let i = 0; i < 7; i++) made.push((await reel(i % 2 ? a.userId : b.userId, { publishedAt: new Date(base + i * 1000) })).id);
      await reel(a.userId, { status: "HIDDEN" });
      await reel(b.userId, { status: "PROCESSING" });
      await reel(stranger.userId);
      // Same instant: the id breaks the tie.
      const same = new Date(base + 100_000);
      const tie = [(await reel(a.userId, { publishedAt: same })).id, (await reel(b.userId, { publishedAt: same })).id].sort().reverse();

      const pages = await walk(() => following(me, "?limit=3"), (c) => following(me, `?limit=3&cursor=${cur(c)}`));
      expect(pages.map((p) => p.length)).toEqual([3, 3, 3]);
      expect(pages.flat()).toEqual([...tie, ...made.slice().reverse()]);
    });

    it("is empty when you follow nobody, needs sign-in, and refuses a cursor from another list or a tampered one", async () => {
      const me = await t.login();
      expect((await following(me)).body).toEqual({ items: [], nextCursor: null });
      expect((await http().get("/v1/feed/following")).status).toBe(401);
      const a = await t.login();
      await follow(me, a);
      for (let i = 0; i < 3; i++) await reel(a.userId);
      const page = await following(me, "?limit=1");
      expect(page.body.nextCursor).toEqual(expect.any(String));
      const tampered = `${page.body.nextCursor.slice(0, -2)}xx`;
      for (const cursor of [tampered, "garbage", page.body.nextCursor.split(".")[0]]) {
        const res = await following(me, `?cursor=${cur(cursor)}`);
        expect([res.status, res.body.error.code]).toEqual([400, "BAD_CURSOR"]);
      }
      const mine = await forYou(me, "?limit=1"); // a For you cursor is not a Following cursor
      if (mine.body.nextCursor) expect((await following(me, `?cursor=${cur(mine.body.nextCursor)}`)).body.error.code).toBe("BAD_CURSOR");
    });

    it("drops a reel that goes hidden or is deleted, and shows each reel in the shared view shape (creator, counts, likedByMe)", async () => {
      const me = await t.login();
      const a = await t.login();
      await follow(me, a);
      const [r1, r2, r3] = [await reel(a.userId), await reel(a.userId), await reel(a.userId)];
      await prisma.reelLike.create({ data: { reelId: r1.id, userId: me.userId } });
      await prisma.reel.update({ where: { id: r2.id }, data: { status: "HIDDEN" } });
      await prisma.reel.update({ where: { id: r3.id }, data: { status: "DELETED", deletedAt: new Date() } });
      const res = await following(me);
      expect(ids(res.body)).toEqual([r1.id]);
      expect(res.body.items[0]).toMatchObject({ id: r1.id, creator: { id: a.userId }, likedByMe: true, savedByMe: false });
    });
  });

  describe("For you", () => {
    it("walks the whole session with no duplicates and no skips, and every reel is published", async () => {
      const me = await t.login();
      const mine = new Set<string>();
      for (const c of await creators(6)) for (let i = 0; i < 3; i++) mine.add((await reel(c.userId, { hashtags: [`walk${uniq()}`] })).id);
      let first: FeedBody | undefined;
      const pages = await walkForYou(me, 7, (p, body) => {
        if (p === 0) first = body;
        expect(body.refreshed).toBe(false);
      });
      const all = pages.flat();
      expect(dup(all)).toBe(0);
      for (const id of mine) expect(all).toContain(id);
      expect(pages.slice(0, -1).every((p) => p.length === 7)).toBe(true);
      expect(first!.items[0]).toMatchObject({ status: "PUBLISHED", creator: { id: expect.any(String) }, counts: expect.any(Object) });
    });

    it("keeps pages stable while the world moves: a new reel and changed counts do not reorder or insert into the session", async () => {
      const me = await t.login();
      for (const c of await creators(12)) await reel(c.userId);
      const p1 = await forYou(me, "?limit=5");
      const planned = (await snapshot(me.userId)).ids;
      expect(ids(p1.body)).toEqual(planned.slice(0, 5));

      // A reel arrives that a fresh ranking would put on top; the engagement of reels further down explodes.
      const star = await reel((await t.login()).userId, { likeCount: 10_000, viewCount: 10_000 });
      await prisma.reel.updateMany({ where: { id: { in: planned.slice(6, 11) } }, data: { likeCount: 50_000, viewCount: 50_000 } });

      const rest = await walk(
        () => forYou(me, `?limit=5&cursor=${cur(p1.body.nextCursor)}`),
        (c) => forYou(me, `?limit=5&cursor=${cur(c)}`),
        (_p, body) => expect(body.refreshed).toBe(false),
      );
      expect(rest.flat()).toEqual(planned.slice(5));
      expect([...ids(p1.body), ...rest.flat()]).not.toContain(star.id);

      // Pulling to refresh (no cursor) is a new session and does see the new reel.
      const fresh = await walkForYou(me, 50);
      expect(fresh.flat()).toContain(star.id);
      expect(dup(fresh.flat())).toBe(0);
    });

    it("skips a reel that became hidden or deleted mid-session without duplicating or dropping the others, and still fills pages", async () => {
      const me = await t.login();
      for (const c of await creators(14)) await reel(c.userId);
      const p1 = await forYou(me, "?limit=4");
      const planned = (await snapshot(me.userId)).ids;
      const hidden = planned[4];
      const deleted = planned[6];
      await prisma.reel.update({ where: { id: hidden }, data: { status: "HIDDEN" } });
      await prisma.reel.update({ where: { id: deleted }, data: { status: "DELETED", deletedAt: new Date() } });
      const rest = await walk(
        () => forYou(me, `?limit=4&cursor=${cur(p1.body.nextCursor)}`),
        (c) => forYou(me, `?limit=4&cursor=${cur(c)}`),
      );
      expect(rest.flat()).toEqual(planned.slice(4).filter((id) => id !== hidden && id !== deleted));
      expect(rest.slice(0, -1).every((p) => p.length === 4)).toBe(true);
    });

    it("starts a fresh ranking, flagged refreshed, when the session expired; another viewer's cursor and a forged one are not trusted", async () => {
      const me = await t.login();
      const other = await t.login();
      for (const c of await creators(6)) await reel(c.userId);
      const p1 = await forYou(me, "?limit=3");
      const cursor = p1.body.nextCursor as string;
      expect((await forYou(me, `?limit=3&cursor=${cur(cursor)}`)).body.refreshed).toBe(false);

      await redis.del(`foryou:u:${me.userId}`);
      const res = await forYou(me, `?limit=3&cursor=${cur(cursor)}`);
      expect([res.status, res.body.refreshed, res.body.items.length]).toEqual([200, true, 3]);
      expect(sessionOf(res.body.nextCursor)).not.toBe(sessionOf(cursor));
      expect((await forYou(me, `?limit=3&cursor=${cur(res.body.nextCursor)}`)).body.refreshed).toBe(false); // the new session carries on normally

      // Someone else's live session is not theirs to read.
      const live = (await forYou(me, "?limit=3")).body.nextCursor as string;
      const stolen = await forYou(other, `?limit=3&cursor=${cur(live)}`);
      expect([stolen.status, stolen.body.refreshed]).toEqual([200, true]);
      const forged = Buffer.from(JSON.stringify({ s: sessionOf(live), o: 0 })).toString("base64url");
      expect((await forYou(me, `?cursor=${cur(`${forged}.AAAA`)}`)).body.error.code).toBe("BAD_CURSOR");
    });

    it("allows at most 2 reels per creator on a page", async () => {
      const me = await t.login();
      const prolific = await t.login();
      for (let i = 0; i < 8; i++) await reel(prolific.userId, { likeCount: 100, viewCount: 100 });
      for (const c of await creators(12)) await reel(c.userId);
      const pages = await walkForYou(me, 10);
      const owner = new Map((await prisma.reel.findMany({ where: { id: { in: pages.flat() } }, select: { id: true, creatorId: true } })).map((r) => [r.id, r.creatorId]));
      const perPage = pages.map((p) => p.filter((id) => owner.get(id) === prolific.userId).length);
      expect(perPage.every((n) => n <= 2)).toBe(true);
      expect(perPage.reduce((a, b) => a + b, 0)).toBe(8); // all of them still show up, in later pages
    });

    it("ranks by interest: a reel with a tag the viewer engages with beats an otherwise identical one; a seen reel sinks", async () => {
      const me = await t.login();
      const liked = await reel((await t.login()).userId, { hashtags: [`topic${uniq()}`] });
      await bus.dispatch({ type: "reel.engaged", userId: me.userId, reelId: liked.id, kind: "like" }, `ev-${uniq()}`);

      const at = new Date(t.clock.now().getTime() - 3600_000);
      const match = await reel((await t.login()).userId, { hashtags: [liked.hashtags[0]], publishedAt: at });
      const plain = await reel((await t.login()).userId, { hashtags: [`other${uniq()}`], publishedAt: at });
      const seen = await reel((await t.login()).userId, { hashtags: [`other${uniq()}`], publishedAt: at });
      await prisma.reelSeen.create({ data: { userId: me.userId, reelId: seen.id, lastSeenAt: new Date(), watchedPct: 100 } });

      const all = (await walkForYou(me, 100)).flat();
      expect(all.indexOf(match.id)).toBeGreaterThanOrEqual(0);
      expect(all.indexOf(match.id)).toBeLessThan(all.indexOf(plain.id));
      expect(all.indexOf(plain.id)).toBeLessThan(all.indexOf(seen.id));
      // Without that history nobody is boosted or sunk: the three are in the order newest/id gives, and all present.
      const stranger = await t.login();
      const theirs = (await walkForYou(stranger, 100)).flat();
      for (const r of [match, plain, seen]) expect(theirs).toContain(r.id);
    });

    it("signed-out viewers get the same ranking, cached for five minutes, and still page without duplicates", async () => {
      await redis.del("foryou-global");
      for (const c of await creators(4)) await reel(c.userId);
      const full = async () => (await walkForYou(null, 25)).flat();
      const first = await full();
      expect(dup(first)).toBe(0);
      const late = await reel((await t.login()).userId, { likeCount: 5000, viewCount: 5000 });
      const cached = await full();
      expect(cached).toEqual(first);
      expect(cached).not.toContain(late.id);
      const ttl = await redis.ttl("foryou-global");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
      await redis.del("foryou-global");
      expect(await full()).toContain(late.id);
    });

    it("keeps memory bounded: 1000 signed-out first pages store no per-session list; a signed-in viewer has exactly one key, overwritten by a fresh first page, at most 300 ids, 30 minutes", async () => {
      for (const c of await creators(3)) for (let i = 0; i < 2; i++) await reel(c.userId);
      await forYou(null, "?limit=1"); // builds the shared list once
      const before = (await foryouKeys()).length;
      for (let i = 0; i < 1000; i++) expect((await forYou(null, "?limit=1")).status).toBe(200);
      expect((await foryouKeys()).length).toBe(before);

      const me = await t.login();
      const mine = () => foryouKeys().then((k) => k.filter((x) => x === `foryou:u:${me.userId}`));
      const p1 = await forYou(me, "?limit=2");
      expect(await mine()).toHaveLength(1);
      const stored = await snapshot(me.userId);
      expect(stored.ids.length).toBeLessThanOrEqual(300);
      expect(await redis.ttl(`foryou:u:${me.userId}`)).toBeLessThanOrEqual(1800);
      expect((await foryouKeys()).length).toBe(before + 1);

      // A fresh first page overwrites that key (still one), and the older cursor no longer matches it: a fresh ranking, flagged refreshed.
      const p2 = await forYou(me, "?limit=2");
      expect(await mine()).toHaveLength(1);
      expect((await foryouKeys()).length).toBe(before + 1);
      expect((await snapshot(me.userId)).g).not.toBe(stored.g);
      // The newest cursor is good; the older one is stale (and its request starts a new list).
      expect((await forYou(me, `?limit=2&cursor=${cur(p2.body.nextCursor)}`)).body.refreshed).toBe(false);
      const stale = await forYou(me, `?limit=2&cursor=${cur(p1.body.nextCursor)}`);
      expect([stale.status, stale.body.refreshed, stale.body.items.length]).toEqual([200, true, 2]);
    });

    it("signed-in lists are capped at 300 ids", async () => {
      const me = await t.login();
      const owner = await t.login();
      const assets = Array.from({ length: 320 }, () => ({ id: randomUUID(), ownerId: owner.userId, purpose: "REEL" as const, bucket: "PUBLIC" as const, status: "READY" as const, objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() }));
      await prisma.mediaAsset.createMany({ data: assets });
      await prisma.reel.createMany({ data: assets.map((a, i) => ({ creatorId: owner.userId, mediaAssetId: a.id, caption: "", hashtags: [], status: "PUBLISHED" as const, publishedAt: new Date(t.clock.now().getTime() - 60_000 - i * 1000) })) });
      await forYou(me, "?limit=10");
      expect((await snapshot(me.userId)).ids.length).toBeLessThanOrEqual(300);
    });

    it("candidates are the newest 300 plus the 300 most engaging of the last 7 days: an older hit survives 600 newer reels with no engagement", async () => {
      const owner = await t.login();
      const hit = await reel(owner.userId, { publishedAt: new Date(t.clock.now().getTime() - 5 * DAY), likeCount: 90_000, viewCount: 100 });
      const assets = Array.from({ length: 600 }, () => ({ id: randomUUID(), ownerId: owner.userId, purpose: "REEL" as const, bucket: "PUBLIC" as const, status: "READY" as const, objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() }));
      await prisma.mediaAsset.createMany({ data: assets });
      await prisma.reel.createMany({ data: assets.map((a, i) => ({ creatorId: owner.userId, mediaAssetId: a.id, caption: "", hashtags: [], status: "PUBLISHED" as const, publishedAt: new Date(t.clock.now().getTime() - 1000 - i * 10) })) });
      const feeds = t.app.get(FeedsService) as unknown as { candidates(): Promise<Array<{ id: string }>> };
      const got = (await feeds.candidates()).map((c) => c.id);
      expect(got).toContain(hit.id);
      expect(got.length).toBeLessThanOrEqual(600);
      expect(new Set(got).size).toBe(got.length);
    });

    it("is rate limited to 120 requests a minute per user", async () => {
      const me = await t.login();
      let last = 200;
      for (let i = 0; i < 121; i++) last = (await following(me)).status;
      expect(last).toBe(429);
    });
  });

  describe("interests", () => {
    const weights = async (userId: string, now = t.clock.now()) => Object.fromEntries((await interests.weights(userId, now)).map((w) => [w.key, w.weight]));
    const engaged = (userId: string, reelId: string, kind: Kind) => ({ type: "reel.engaged", userId, reelId, kind }) as const;

    it("engagement writes an outbox event in the same transaction: like, save, comment, share (counted once) and a view of half or more", async () => {
      const owner = await t.login();
      const me = await t.login();
      const r = await reel(owner.userId, { hashtags: ["x"] });
      const events = async () => (await prisma.outboxEvent.findMany({ where: { type: "reel.engaged", payload: { path: ["userId"], equals: me.userId } }, orderBy: { id: "asc" } })).map((e) => (e.payload as { kind: string }).kind);
      const beacon = (watchedSec: number) => http().post(`/v1/reels/${r.id}/views`).set(auth(me)).set("X-Forwarded-For", uniqueIp()).send({ watchedSec });

      await http().put(`/v1/reels/${r.id}/like`).set(auth(me)).expect(200);
      await http().put(`/v1/reels/${r.id}/like`).set(auth(me)).expect(200); // repeated: no second event
      await http().put(`/v1/reels/${r.id}/save`).set(auth(me)).expect(200);
      await http().post(`/v1/reels/${r.id}/comments`).set(auth(me)).send({ body: "nice" }).expect(201);
      await http().post(`/v1/reels/${r.id}/shares`).set(auth(me)).send({ channel: "copy_link" }).expect(200);
      await http().post(`/v1/reels/${r.id}/shares`).set(auth(me)).send({ channel: "whatsapp" }).expect(200); // same day: not counted again
      expect(await events()).toEqual(["like", "save", "comment", "share"]);

      // 10 of 30 s is under half; 20 s is over, and only the first crossing counts.
      await beacon(10).expect(202);
      expect(await events()).toHaveLength(4);
      await beacon(20).expect(202);
      await beacon(30).expect(202);
      expect(await events()).toEqual(["like", "save", "comment", "share", "view"]);
    });

    it("turns events into weights on the reel's tags and its course's category (like 1, save 2, comment 1.5, share 2, view 0.5), once per event", async () => {
      const cat = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
      const owner = await t.login();
      const course = await prisma.course.create({
        data: { ownerType: "USER", ownerId: owner.userId, createdById: owner.userId, slug: `c-${uniq()}`, title: "Interest course", description: "d", categoryId: cat, language: "en", pricePaise: 100n, status: "PUBLISHED", publishedAt: new Date() },
      });
      const tag1 = `a${uniq()}`;
      const tag2 = `b${uniq()}`;
      const r = await reel(owner.userId, { hashtags: [tag1, tag2], linkedCourseId: course.id });
      const me = await t.login();
      const ev = (kind: Kind, id: string) => bus.dispatch(engaged(me.userId, r.id, kind), id);

      const first = `e1-${uniq()}`;
      await ev("like", first);
      await ev("like", first); // redelivery
      expect(await weights(me.userId)).toEqual({ [`tag:${tag1}`]: 1, [`tag:${tag2}`]: 1, [`cat:${cat}`]: 1 });
      const base = uniq();
      await ev("save", `${base}-s`);
      await ev("comment", `${base}-c`);
      await ev("share", `${base}-h`);
      await ev("view", `${base}-v`);
      await ev("save", `${base}-s`);
      expect((await weights(me.userId))[`tag:${tag1}`]).toBeCloseTo(1 + 2 + 1.5 + 2 + 0.5, 6);
      expect((await weights(me.userId))[`cat:${cat}`]).toBeCloseTo(7, 6);
    });

    it("a failed update is retried: the event is not marked processed until its weights are written", async () => {
      const owner = await t.login();
      const me = await t.login();
      const r = await reel(owner.userId, { hashtags: [`f${uniq()}`] });
      const id = `fail-${uniq()}`;
      const spy = jest.spyOn(interests, "add").mockRejectedValueOnce(new Error("db down"));
      await expect(bus.dispatch(engaged(me.userId, r.id, "like"), id)).rejects.toThrow("db down");
      spy.mockRestore();
      await bus.dispatch(engaged(me.userId, r.id, "like"), id); // BullMQ retry
      expect((await weights(me.userId))[`tag:${r.hashtags[0]}`]).toBe(1);
    });

    it("ignores engagement with your own reel and with reels that are gone", async () => {
      const me = await t.login();
      const mine = await reel(me.userId, { hashtags: [`own${uniq()}`] });
      await bus.dispatch(engaged(me.userId, mine.id, "like"), `own-${uniq()}`);
      await bus.dispatch(engaged(me.userId, randomUUID(), "like"), `gone-${uniq()}`);
      expect(await weights(me.userId)).toEqual({});
    });

    it("decays 2% a day, applied lazily on read and on update", async () => {
      const me = await t.login();
      const now = t.clock.now();
      await interests.add(me.userId, ["tag:decay"], 10, now);
      const later = new Date(now.getTime() + 10 * DAY);
      expect((await weights(me.userId, later))["tag:decay"]).toBeCloseTo(10 * 0.98 ** 10, 6);
      await interests.add(me.userId, ["tag:decay"], 1, later);
      expect((await weights(me.userId, later))["tag:decay"]).toBeCloseTo(10 * 0.98 ** 10 + 1, 6);
      // Reading does not write: asking again at the same instant gives the same number.
      expect((await weights(me.userId, later))["tag:decay"]).toBeCloseTo(10 * 0.98 ** 10 + 1, 6);
      // A very old, faded interest drops out of the profile.
      expect((await weights(me.userId, new Date(now.getTime() + 2000 * DAY)))["tag:decay"]).toBeUndefined();
    });
  });
});
