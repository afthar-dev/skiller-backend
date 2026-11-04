import { randomUUID } from "node:crypto";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("reel posting", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  /** A creator on the Business plan (50 reels a day) unless told otherwise. */
  async function creator(plan: string | null = "business") {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    if (plan) await givePlan(prisma, "USER", s.userId, plan);
    return s;
  }
  const asset = (ownerId: string, opts: { status?: "READY" | "PROCESSING" | "FAILED"; purpose?: "REEL" | "THUMBNAIL" } = {}) =>
    prisma.mediaAsset.create({
      data: { ownerId, purpose: opts.purpose ?? "REEL", bucket: "PUBLIC", status: opts.status ?? "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, posterKey: opts.status === "PROCESSING" ? null : `reel/${uniq()}/poster.jpg` },
    });
  const post = (s: Session, body: Record<string, unknown>) => http().post("/v1/reels").set(auth(s)).send(body);
  const reelRow = (id: string) => prisma.reel.findUniqueOrThrow({ where: { id } });
  const assetRow = (id: string) => prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
  const tagCount = async (tag: string) => (await prisma.hashtag.findUnique({ where: { tag } }))?.reelCount ?? 0;
  const markReady = async (assetId: string, ownerId: string) => {
    await prisma.mediaAsset.update({ where: { id: assetId }, data: { status: "READY", posterKey: `reel/${uniq()}/poster.jpg` } });
    await bus.dispatch({ type: "media.ready", assetId, ownerId, purpose: "reel" }, `evt-${assetId}`);
  };
  async function course(owner: Session, status: "PUBLISHED" | "DRAFT" = "PUBLISHED") {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Linked ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "49900" });
    expect(res.status).toBe(201);
    if (status === "PUBLISHED") await prisma.course.update({ where: { id: res.body.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return res.body as { id: string; slug: string; title: string };
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("who may post what", () => {
    it("is for signed-in creators only", async () => {
      const member = await t.login();
      const a = await asset(member.userId);
      expect((await post(member, { mediaAssetId: a.id, caption: "hi" })).status).toBe(403);
      expect((await http().post("/v1/reels").send({ mediaAssetId: a.id, caption: "hi" })).status).toBe(401);
    });

    it("takes only the creator's own, REEL-purpose, not failed media", async () => {
      const me = await creator();
      const other = await creator();
      const code = async (mediaAssetId: string) => {
        const res = await post(me, { mediaAssetId, caption: "x" });
        return [res.status, res.body.error?.code];
      };
      expect(await code((await asset(other.userId)).id)).toEqual([422, "MEDIA_NOT_USABLE"]);
      expect(await code((await asset(me.userId, { purpose: "THUMBNAIL" })).id)).toEqual([422, "MEDIA_NOT_USABLE"]);
      expect(await code((await asset(me.userId, { status: "FAILED" })).id)).toEqual([422, "MEDIA_NOT_USABLE"]);
      expect(await code(randomUUID())).toEqual([422, "MEDIA_NOT_USABLE"]);
      expect(await prisma.reel.count({ where: { creatorId: me.userId } })).toBe(0);
    });

    it("one video makes one reel", async () => {
      const me = await creator();
      const a = await asset(me.userId);
      expect((await post(me, { mediaAssetId: a.id, caption: "first" })).status).toBe(201);
      const again = await post(me, { mediaAssetId: a.id, caption: "second" });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("MEDIA_NOT_USABLE");
    });

    it("validates the body: caption at most 2,200 characters, unknown fields refused", async () => {
      const me = await creator();
      const a = await asset(me.userId);
      expect((await post(me, { mediaAssetId: a.id, caption: "x".repeat(2201) })).status).toBe(400);
      expect((await post(me, { mediaAssetId: a.id, caption: "ok", surprise: true })).status).toBe(400);
      expect((await post(me, { caption: "no media" })).status).toBe(400);
    });
  });

  describe("publishing", () => {
    it("publishes a READY video at once: attached to the reel, plain-text caption, hashtags parsed and counted", async () => {
      const me = await creator();
      const a = await asset(me.userId);
      const tag = `tag${uniq()}`;
      const res = await post(me, { mediaAssetId: a.id, caption: `Hello\u202e world\u200b #${tag.toUpperCase()} #${tag} #Next_${tag}\n\n\n\nbye` });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "PUBLISHED", caption: `Hello world #${tag.toUpperCase()} #${tag} #Next_${tag}\n\nbye`, hashtags: [tag, `next_${tag}`], commentsEnabled: true, creator: { id: me.userId } });
      expect(res.body.publishedAt).toEqual(expect.any(String));
      expect((await assetRow(a.id)).attachedAt).not.toBeNull();
      expect(await tagCount(tag)).toBe(1);
      expect((await prisma.hashtag.findUniqueOrThrow({ where: { tag } })).lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("keeps a PROCESSING reel until media.ready, then publishes it; a redelivered event changes nothing", async () => {
      const me = await creator();
      const a = await asset(me.userId, { status: "PROCESSING" });
      const tag = `wait${uniq()}`;
      const res = await post(me, { mediaAssetId: a.id, caption: `#${tag}` });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("PROCESSING");
      expect(res.body.publishedAt).toBeNull();
      expect(await tagCount(tag)).toBe(0);
      expect((await assetRow(a.id)).attachedAt).toBeNull();
      // Only the owner sees an unpublished reel.
      expect((await http().get(`/v1/reels/${res.body.id}`)).status).toBe(404);
      expect((await http().get(`/v1/reels/${res.body.id}`).set(auth(me))).body.status).toBe("PROCESSING");

      await markReady(a.id, me.userId);
      const row = await reelRow(res.body.id);
      expect(row.status).toBe("PUBLISHED");
      expect(row.publishedAt).not.toBeNull();
      expect((await assetRow(a.id)).attachedAt).not.toBeNull();
      expect(await tagCount(tag)).toBe(1);

      await bus.dispatch({ type: "media.ready", assetId: a.id, ownerId: me.userId, purpose: "reel" }, `evt-${a.id}`);
      expect(await tagCount(tag)).toBe(1);
      expect((await reelRow(res.body.id)).publishedAt).toEqual(row.publishedAt);
      expect(await prisma.notification.count({ where: { userId: me.userId, type: "reel.published", data: { path: ["reelId"], equals: res.body.id } } })).toBe(1);
    });

    it("fails the reel when processing fails, tells the creator, and ignores a late ready", async () => {
      const me = await creator();
      const a = await asset(me.userId, { status: "PROCESSING" });
      const res = await post(me, { mediaAssetId: a.id, caption: "doomed #never" });
      await prisma.mediaAsset.update({ where: { id: a.id }, data: { status: "FAILED", failureReason: "INVALID_MEDIA" } });
      await bus.dispatch({ type: "media.failed", assetId: a.id, ownerId: me.userId, reason: "INVALID_MEDIA" }, `fail-${a.id}`);
      await bus.dispatch({ type: "media.failed", assetId: a.id, ownerId: me.userId, reason: "INVALID_MEDIA" }, `fail-${a.id}`);
      expect(await reelRow(res.body.id)).toMatchObject({ status: "FAILED", failureReason: "INVALID_MEDIA" });
      expect(await prisma.notification.count({ where: { userId: me.userId, type: "reel.failed", data: { path: ["reelId"], equals: res.body.id } } })).toBe(1);
      await bus.dispatch({ type: "media.ready", assetId: a.id, ownerId: me.userId, purpose: "reel" }, `late-${a.id}`);
      expect((await reelRow(res.body.id)).status).toBe("FAILED");
      expect(await tagCount("never")).toBe(0);
    });

    it("ignores media events for assets that are not reels", async () => {
      const me = await creator();
      const a = await asset(me.userId, { purpose: "THUMBNAIL" });
      await bus.dispatch({ type: "media.ready", assetId: a.id, ownerId: me.userId, purpose: "thumbnail" }, `thumb-${a.id}`);
      expect(await prisma.reel.count({ where: { mediaAssetId: a.id } })).toBe(0);
    });
  });

  describe("linked course", () => {
    it("links only a PUBLISHED course the creator authors, and re-checks on every edit that sets it", async () => {
      const me = await creator();
      const other = await creator();
      const mine = await course(me);
      const draft = await course(me, "DRAFT");
      const theirs = await course(other);
      const a = await asset(me.userId);
      for (const bad of [draft.id, theirs.id, randomUUID()]) {
        const res = await post(me, { mediaAssetId: a.id, caption: "x", linkedCourseId: bad });
        expect([res.status, res.body.error.code]).toEqual([422, "COURSE_NOT_LINKABLE"]);
      }
      expect(await prisma.reel.count({ where: { creatorId: me.userId } })).toBe(0);
      const ok = await post(me, { mediaAssetId: a.id, caption: "x", linkedCourseId: mine.id });
      expect(ok.status).toBe(201);
      expect(ok.body.course).toMatchObject({ id: mine.id, slug: mine.slug, title: mine.title, pricePaise: "49900" });

      const patch = (body: Record<string, unknown>) => http().patch(`/v1/reels/${ok.body.id}`).set(auth(me)).send(body);
      expect((await patch({ linkedCourseId: theirs.id })).body.error.code).toBe("COURSE_NOT_LINKABLE");
      expect((await patch({ linkedCourseId: null })).body.course).toBeNull();
      expect((await patch({ linkedCourseId: mine.id })).body.course.id).toBe(mine.id);
    });

    it("keeps the reel when the course stops being available, but leaves the link card out", async () => {
      const me = await creator();
      const c = await course(me);
      const res = await post(me, { mediaAssetId: (await asset(me.userId)).id, caption: "x", linkedCourseId: c.id });
      expect(res.body.course.id).toBe(c.id);
      await prisma.course.update({ where: { id: c.id }, data: { status: "DRAFT" } });
      const view = await http().get(`/v1/reels/${res.body.id}`);
      expect(view.status).toBe(200);
      expect(view.body.course).toBeNull();
      await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", flaggedAt: new Date() } });
      expect((await http().get(`/v1/reels/${res.body.id}`)).body.course).toBeNull();
    });
  });

  describe("reading", () => {
    it("shows a published reel to anyone: creator, HLS and poster, hashtags, counts", async () => {
      const me = await creator();
      const a = await asset(me.userId);
      const res = await post(me, { mediaAssetId: a.id, caption: "Look #view" });
      const view = await http().get(`/v1/reels/${res.body.id}`);
      expect(view.status).toBe(200);
      const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: me.userId } });
      expect(view.body).toMatchObject({
        id: res.body.id,
        status: "PUBLISHED",
        caption: "Look #view",
        hashtags: ["view"],
        creator: { id: me.userId, handle: profile.handle, displayName: profile.displayName },
        counts: { likes: 0, comments: 0, saves: 0, shares: 0, views: 0 },
        course: null,
      });
      expect(view.body.media.hls).toMatch(/\.m3u8$/);
      expect(view.body.media.poster).toEqual(expect.any(String));
      expect(view.body).not.toHaveProperty("likedByMe");
    });

    it("lists a creator's published reels newest first, paged, and nothing else", async () => {
      const me = await creator();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        t.clock.advanceSec(2);
        ids.push((await post(me, { mediaAssetId: (await asset(me.userId)).id, caption: `reel ${i}` })).body.id);
      }
      const processing = await post(me, { mediaAssetId: (await asset(me.userId, { status: "PROCESSING" })).id, caption: "later" });
      const deleted = await post(me, { mediaAssetId: (await asset(me.userId)).id, caption: "gone" });
      await http().delete(`/v1/reels/${deleted.body.id}`).set(auth(me)).expect(204);
      const handle = (await prisma.profile.findUniqueOrThrow({ where: { userId: me.userId } })).handle;

      const page1 = await http().get(`/v1/profiles/${handle}/reels?limit=2`);
      expect(page1.status).toBe(200);
      expect(page1.body.items.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await http().get(`/v1/profiles/${handle}/reels?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
      expect(page2.body.items.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
      expect(page2.body.nextCursor).toBeNull();
      expect(page1.body.items.concat(page2.body.items).map((r: { id: string }) => r.id)).not.toContain(processing.body.id);
      expect((await http().get(`/v1/profiles/${handle}/reels?cursor=garbage`)).body.error.code).toBe("BAD_CURSOR");
      expect((await http().get("/v1/profiles/nobody-here-xyz/reels")).status).toBe(404);
    });

    it("404s for unknown ids", async () => {
      expect((await http().get(`/v1/reels/${randomUUID()}`)).status).toBe(404);
    });
  });

  describe("editing", () => {
    it("changes caption, link and comments flag; hashtag counts follow the caption of a published reel", async () => {
      const me = await creator();
      const [a, b] = [`old${uniq()}`, `new${uniq()}`];
      const res = await post(me, { mediaAssetId: (await asset(me.userId)).id, caption: `#${a} #keep` });
      expect(await tagCount(a)).toBe(1);
      const keepBefore = await tagCount("keep");
      const patched = await http().patch(`/v1/reels/${res.body.id}`).set(auth(me)).send({ caption: `now #${b} #keep \u202e`, commentsEnabled: false });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ caption: `now #${b} #keep`, hashtags: [b, "keep"], commentsEnabled: false });
      expect(await tagCount(a)).toBe(0);
      expect(await tagCount(b)).toBe(1);
      expect(await tagCount("keep")).toBe(keepBefore);
    });

    it("does not count tags of a reel that is not published yet", async () => {
      const me = await creator();
      const tag = `soon${uniq()}`;
      const a = await asset(me.userId, { status: "PROCESSING" });
      const res = await post(me, { mediaAssetId: a.id, caption: "none" });
      await http().patch(`/v1/reels/${res.body.id}`).set(auth(me)).send({ caption: `#${tag}` }).expect(200);
      expect(await tagCount(tag)).toBe(0);
      await markReady(a.id, me.userId);
      expect(await tagCount(tag)).toBe(1);
    });

    it("is for the creator only: others see 404, anonymous 401; validation applies", async () => {
      const me = await creator();
      const other = await creator();
      const res = await post(me, { mediaAssetId: (await asset(me.userId)).id, caption: "mine" });
      expect((await http().patch(`/v1/reels/${res.body.id}`).set(auth(other)).send({ caption: "hijack" })).status).toBe(404);
      expect((await http().patch(`/v1/reels/${res.body.id}`).send({ caption: "hijack" })).status).toBe(401);
      expect((await http().patch(`/v1/reels/${res.body.id}`).set(auth(me)).send({ caption: "x".repeat(2201) })).status).toBe(400);
      expect((await http().patch(`/v1/reels/${res.body.id}`).set(auth(me)).send({ mediaAssetId: randomUUID() })).status).toBe(400);
      expect((await reelRow(res.body.id)).caption).toBe("mine");
    });
  });

  describe("deleting", () => {
    it("soft-deletes: gone from every read, media released, tag counts down; deleting again is harmless", async () => {
      const me = await creator();
      const other = await creator();
      const tag = `bye${uniq()}`;
      const a = await asset(me.userId);
      const res = await post(me, { mediaAssetId: a.id, caption: `#${tag}` });
      expect(await tagCount(tag)).toBe(1);
      expect((await http().delete(`/v1/reels/${res.body.id}`).set(auth(other))).status).toBe(404);
      expect((await http().delete(`/v1/reels/${res.body.id}`).set(auth(me))).status).toBe(204);
      const row = await reelRow(res.body.id);
      expect(row.status).toBe("DELETED");
      expect(row.deletedAt).not.toBeNull();
      expect(row.publishedAt).not.toBeNull(); // the daily limit counts publish events: the slot stays used
      const media = await assetRow(a.id);
      expect(media.attachedAt).toBeNull();
      expect(media.detachedAt).not.toBeNull();
      expect(await tagCount(tag)).toBe(0);
      expect((await http().get(`/v1/reels/${res.body.id}`)).status).toBe(404);
      expect((await http().get(`/v1/reels/${res.body.id}`).set(auth(me))).status).toBe(404);
      expect((await http().delete(`/v1/reels/${res.body.id}`).set(auth(me))).status).toBe(204);
      expect(await tagCount(tag)).toBe(0);
      expect((await http().patch(`/v1/reels/${res.body.id}`).set(auth(me)).send({ caption: "back" })).status).toBe(404);
    });

    it("a deleted PROCESSING reel stays deleted when its video finishes", async () => {
      const me = await creator();
      const a = await asset(me.userId, { status: "PROCESSING" });
      const res = await post(me, { mediaAssetId: a.id, caption: "#ghost" });
      await http().delete(`/v1/reels/${res.body.id}`).set(auth(me)).expect(204);
      await markReady(a.id, me.userId);
      expect((await reelRow(res.body.id)).status).toBe("DELETED");
      expect((await assetRow(a.id)).attachedAt).toBeNull();
    });
  });

  describe("unlimited plans", () => {
    it("reels_per_day null means no daily limit", async () => {
      const me = await creator(null);
      const plan = await prisma.plan.create({ data: { key: `unlimited_${uniq()}`, name: "Unlimited reels", audience: "CREATOR" } });
      const version = await prisma.planVersion.create({
        data: { planId: plan.id, pricePaise: 0n, interval: "MONTH", commissionBps: 500, limits: { max_published_courses: null, storage_gb: null, reels_per_day: null, analytics_level: "basic", creator_coupons: false, org_seats: 0 } },
      });
      await prisma.subscription.create({ data: { ownerType: "USER", ownerId: me.userId, planVersionId: version.id, status: "ACTIVE" } });
      for (let i = 0; i < 4; i++) expect((await post(me, { mediaAssetId: (await asset(me.userId)).id, caption: `n${i}` })).body.status).toBe("PUBLISHED");
    });
  });
});
