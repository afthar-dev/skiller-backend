import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { istDateOf } from "../../src/modules/billing";
import { ProfilesService } from "../../src/modules/users";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { checkDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

// Every reel, feed, hashtag, reel search, reel studio analytics, report and notification response, checked against the schema in openapi.json.
describe("typed responses: reels, feeds, hashtags, analytics, reports and notifications", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const get = (path: string, s?: Session) => {
    const req = http().get(path).set("X-Forwarded-For", uniqueIp());
    return s ? req.set(auth(s)) : req;
  };
  /** The response must be a 2xx (`status`) that matches the schema declared for `key`. */
  const declared = <T extends { status: number; body: unknown }>(res: T, key: string, status: number): T => {
    expect(res.status).toBe(status);
    return checkDeclared(res, key);
  };

  async function creator(plan = "business") {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, plan);
    return s;
  }
  const asset = (ownerId: string, purpose: "THUMBNAIL" | "REEL" | "AVATAR" = "REEL") =>
    prisma.mediaAsset.create({
      data: {
        ownerId,
        purpose,
        bucket: "PUBLIC",
        status: "READY",
        objectKey: `incoming/${uniq()}/source`,
        mime: purpose === "REEL" ? "video/mp4" : "image/png",
        declaredSize: 10n,
        ...(purpose === "REEL" ? { durationSec: 30, posterKey: `reel/${uniq()}/poster.jpg` } : { renditions: { "256": `images/${uniq()}/256.webp`, "1024": `images/${uniq()}/1024.webp` } }),
      },
    });
  const postReel = async (s: Session, body: Record<string, unknown> = {}, status = 201) => {
    const a = await asset(s.userId);
    return declared(await http().post("/v1/reels").set(auth(s)).send({ mediaAssetId: a.id, caption: `contract ${uniq()}`, ...body }), "POST /v1/reels", status);
  };
  async function publishedCourse(owner: Session) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Linked ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "49900" });
    expect(res.status).toBe(201);
    await prisma.course.update({ where: { id: res.body.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return res.body.id as string;
  }
  async function liveGig(owner: Session) {
    const cover = await asset(owner.userId, "THUMBNAIL");
    const res = await http()
      .post("/v1/studio/gigs")
      .set(auth(owner))
      .send({ title: `Gig ${uniq()}`, description: "A fine offer", categoryId, tags: [], packages: [{ tier: "BASIC", name: "Basic", description: "d", pricePaise: "49900", deliveryDays: 3, revisions: 1, features: [] }], coverAssetId: cover.id });
    expect(res.status).toBe(201);
    expect((await http().post(`/v1/studio/gigs/${res.body.id}/activate`).set(auth(owner))).status).toBe(200);
    return res.body.id as string;
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  it("reels: create, read, edit, publish, delete; with a course link, a gig link and an avatar", async () => {
    const owner = await creator();
    const profiles = t.app.get(ProfilesService);
    const handle = (await profiles.ensure(owner.userId)).handle;
    await prisma.profile.update({ where: { userId: owner.userId }, data: { avatarAssetId: (await asset(owner.userId, "AVATAR")).id } });
    const courseId = await publishedCourse(owner);
    const gigId = await liveGig(owner);

    const plain = await postReel(owner, { caption: `plain #tag${uniq()}` });
    const withCourse = await postReel(owner, { linkedCourseId: courseId });
    expect(withCourse.body.course).not.toBeNull();
    expect(withCourse.body.creator.avatar).not.toBeNull();
    const withGig = await postReel(owner, { linkedGigId: gigId });
    expect(withGig.body.gig).not.toBeNull();

    // A reel still processing, and one waiting for the daily limit: the creator sees them, with failureReason.
    const processing = await prisma.mediaAsset.create({ data: { ownerId: owner.userId, purpose: "REEL", bucket: "PUBLIC", status: "PROCESSING", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n } });
    const waiting = declared(await http().post("/v1/reels").set(auth(owner)).send({ mediaAssetId: processing.id, caption: "still processing" }), "POST /v1/reels", 201);
    expect(waiting.body.status).toBe("PROCESSING");
    declared(await get(`/v1/reels/${waiting.body.id}`, owner), "GET /v1/reels/{id}", 200);
    declared(await http().post(`/v1/reels/${plain.body.id}/publish`).set(auth(owner)), "POST /v1/reels/{id}/publish", 200);

    const viewer = await t.login();
    declared(await get(`/v1/reels/${plain.body.id}`), "GET /v1/reels/{id}", 200);
    declared(await get(`/v1/reels/${withCourse.body.id}`, viewer), "GET /v1/reels/{id}", 200);
    declared(await get(`/v1/reels/${withGig.body.id}`, viewer), "GET /v1/reels/{id}", 200);
    declared(await http().patch(`/v1/reels/${plain.body.id}`).set(auth(owner)).send({ caption: `edited #tag${uniq()}`, commentsEnabled: false }), "PATCH /v1/reels/{id}", 200);
    declared(await get(`/v1/profiles/${handle}/reels`, viewer), "GET /v1/profiles/{handle}/reels", 200);
    declared(await get(`/v1/profiles/${handle}/reels?limit=1`), "GET /v1/profiles/{handle}/reels", 200);

    expect((await http().delete(`/v1/reels/${waiting.body.id}`).set(auth(owner))).status).toBe(204);
    const gone = await get(`/v1/reels/${waiting.body.id}`, owner);
    expect(gone.status).toBe(404);
  });

  it("feeds, saved reels, hashtags and search", async () => {
    const owner = await creator();
    const tag = `ctr${uniq()}`;
    const word = `zq${uniq()}`;
    const reel = await postReel(owner, { caption: `${word} reel #${tag}` });
    const viewer = await t.login();
    await t.app.get(ProfilesService).ensure(viewer.userId);
    await t.app.get(ProfilesService).ensure(owner.userId);
    await prisma.follow.createMany({ data: [{ followerId: viewer.userId, followeeId: owner.userId }], skipDuplicates: true });

    const following = declared(await get("/v1/feed/following", viewer), "GET /v1/feed/following", 200);
    expect(following.body.items.length).toBeGreaterThan(0);
    declared(await get("/v1/feed/following?limit=1", viewer), "GET /v1/feed/following", 200);
    const forYou = declared(await get("/v1/feed/for-you", viewer), "GET /v1/feed/for-you", 200);
    expect(forYou.body).toHaveProperty("refreshed");
    declared(await get("/v1/feed/for-you"), "GET /v1/feed/for-you", 200);

    declared(await http().put(`/v1/reels/${reel.body.id}/save`).set(auth(viewer)), "PUT /v1/reels/{id}/save", 200);
    const saved = declared(await get("/v1/me/saved-reels", viewer), "GET /v1/me/saved-reels", 200);
    expect(saved.body.items.map((r: { id: string }) => r.id)).toContain(reel.body.id);

    const byTag = declared(await get(`/v1/hashtags/${tag}/reels`, viewer), "GET /v1/hashtags/{tag}/reels", 200);
    expect(byTag.body).toMatchObject({ tag, reelCount: 1 });
    declared(await get(`/v1/hashtags/${tag}/reels?sort=recent`), "GET /v1/hashtags/{tag}/reels", 200);
    declared(await get("/v1/hashtags/trending"), "GET /v1/hashtags/trending", 200);

    const found = declared(await get(`/v1/reels/search?q=${word}`, viewer), "GET /v1/reels/search", 200);
    expect(found.body.items.map((r: { id: string }) => r.id)).toContain(reel.body.id);
    declared(await get("/v1/reels/search?q="), "GET /v1/reels/search", 200);
  });

  it("likes, saves, shares, views and link clicks", async () => {
    const owner = await creator();
    const reel = await postReel(owner, { linkedCourseId: await publishedCourse(owner) });
    const id = reel.body.id as string;
    const me = await t.login();

    declared(await http().put(`/v1/reels/${id}/like`).set(auth(me)), "PUT /v1/reels/{id}/like", 200);
    declared(await http().delete(`/v1/reels/${id}/like`).set(auth(me)), "DELETE /v1/reels/{id}/like", 200);
    declared(await http().put(`/v1/reels/${id}/save`).set(auth(me)), "PUT /v1/reels/{id}/save", 200);
    declared(await http().delete(`/v1/reels/${id}/save`).set(auth(me)), "DELETE /v1/reels/{id}/save", 200);
    const share = declared(await http().post(`/v1/reels/${id}/shares`).set(auth(me)).send({ channel: "copy_link" }), "POST /v1/reels/{id}/shares", 200);
    expect(share.body.counted).toBe(true);
    declared(await http().post(`/v1/reels/${id}/shares`).set("X-Forwarded-For", uniqueIp()).send({ channel: "other" }), "POST /v1/reels/{id}/shares", 200);
    const view = declared(await http().post(`/v1/reels/${id}/views`).set(auth(me)).send({ watchedSec: 10 }), "POST /v1/reels/{id}/views", 202);
    expect(view.body.counted).toBe(true);
    declared(await http().post(`/v1/reels/${id}/views`).set("X-Forwarded-For", uniqueIp()).send({ watchedSec: 1 }), "POST /v1/reels/{id}/views", 202);
    const click = declared(await http().post(`/v1/reels/${id}/link-click`).set(auth(me)).send({}), "POST /v1/reels/{id}/link-click", 202);
    expect(click.body.counted).toBe(true);
  });

  it("comments: create, reply, edit, list, replies, delete", async () => {
    const owner = await creator();
    const reel = await postReel(owner);
    const id = reel.body.id as string;
    const me = await t.login();

    const top = declared(await http().post(`/v1/reels/${id}/comments`).set(auth(me)).send({ body: "first!" }), "POST /v1/reels/{id}/comments", 201);
    const reply = declared(await http().post(`/v1/reels/${id}/comments`).set(auth(owner)).send({ body: "thanks", parentId: top.body.id }), "POST /v1/reels/{id}/comments", 201);
    declared(await http().patch(`/v1/reels/${id}/comments/${top.body.id}`).set(auth(me)).send({ body: "first! (edited)" }), "PATCH /v1/reels/{id}/comments/{commentId}", 200);
    const list = declared(await get(`/v1/reels/${id}/comments`, me), "GET /v1/reels/{id}/comments", 200);
    expect(list.body.items[0]).toMatchObject({ id: top.body.id, replyCount: 1, mine: true });
    declared(await get(`/v1/reels/${id}/comments`), "GET /v1/reels/{id}/comments", 200);
    const replies = declared(await get(`/v1/reels/${id}/comments/${top.body.id}/replies`, me), "GET /v1/reels/{id}/comments/{commentId}/replies", 200);
    expect(replies.body.items.map((r: { id: string }) => r.id)).toEqual([reply.body.id]);

    // The author deletes a comment that has a reply: it stays as the "[deleted]" placeholder, whose author is null.
    expect((await http().delete(`/v1/reels/${id}/comments/${top.body.id}`).set(auth(me))).status).toBe(204);
    const placeholder = declared(await get(`/v1/reels/${id}/comments`, me), "GET /v1/reels/{id}/comments", 200);
    expect(placeholder.body.items[0]).toMatchObject({ body: "[deleted]", status: "DELETED", author: null });
    expect((await http().delete(`/v1/reels/${id}/comments/${reply.body.id}`).set(auth(owner))).status).toBe(204);
  });

  it("reel analytics: totals only on the free plan, the daily series and top reels on a paid one", async () => {
    const free = await creator("free");
    const paid = await creator("business");
    const freeReel = await prisma.reel.create({ data: { creatorId: free.userId, mediaAssetId: (await asset(free.userId)).id, caption: "free", hashtags: [], status: "PUBLISHED", publishedAt: new Date() } });
    const paidReel = await prisma.reel.create({ data: { creatorId: paid.userId, mediaAssetId: (await asset(paid.userId)).id, caption: "paid", hashtags: [], status: "PUBLISHED", publishedAt: new Date() } });
    const today = istDateOf(t.clock.now());
    await prisma.reelViewDaily.create({ data: { reelId: paidReel.id, day: today, views: 4, watchSec: 60, uniqueViewers: 3, linkClicks: 1 } });

    const mineList = declared(await get("/v1/studio/reels", free), "GET /v1/studio/reels", 200);
    expect(mineList.body.items.map((r: { id: string }) => r.id)).toEqual([freeReel.id]);
    const basic = declared(await get("/v1/studio/reels/analytics", free), "GET /v1/studio/reels/analytics", 200);
    expect(basic.body.upgradeRequired).toBe(true);
    expect(basic.body).not.toHaveProperty("daily");
    const full = declared(await get("/v1/studio/reels/analytics", paid), "GET /v1/studio/reels/analytics", 200);
    expect(full.body.upgradeRequired).toBe(false);
    expect(full.body.topReels).toHaveLength(1);
    expect(full.body.daily.length).toBe(30);
    declared(await get(`/v1/studio/reels/analytics?from=${today}&to=${today}`, paid), "GET /v1/studio/reels/analytics", 200);

    declared(await get(`/v1/studio/reels/${freeReel.id}/analytics`, free), "GET /v1/studio/reels/{id}/analytics", 200);
    const one = declared(await get(`/v1/studio/reels/${paidReel.id}/analytics`, paid), "GET /v1/studio/reels/{id}/analytics", 200);
    expect(one.body).toMatchObject({ reelId: paidReel.id, newFollowersScope: "creator" });
    expect(one.body.daily).toBeDefined();
  });

  it("reports, and the notifications they and a like leave", async () => {
    const owner = await creator();
    const reel = await postReel(owner);
    const id = reel.body.id as string;
    const me = await t.login();

    const comment = declared(await http().post(`/v1/reels/${id}/comments`).set(auth(me)).send({ body: "a comment" }), "POST /v1/reels/{id}/comments", 201);
    declared(await http().put(`/v1/reels/${id}/like`).set(auth(me)), "PUT /v1/reels/{id}/like", 200);

    declared(await http().post("/v1/reports").set(auth(me)).send({ targetType: "REEL", targetId: id, reason: "SPAM", note: "ad" }), "POST /v1/reports", 201);
    declared(await http().post("/v1/reports").set(auth(me)).send({ targetType: "REEL", targetId: id, reason: "SPAM" }), "POST /v1/reports", 200);
    declared(await http().post("/v1/reports").set(auth(owner)).send({ targetType: "REEL_COMMENT", targetId: comment.body.id, reason: "SPAM" }), "POST /v1/reports", 201);

    const unread = declared(await get("/v1/notifications/unread-count", owner), "GET /v1/notifications/unread-count", 200);
    expect(unread.body.count).toBeGreaterThan(0);
    const list = declared(await get("/v1/notifications", owner), "GET /v1/notifications", 200);
    expect(list.body.items.length).toBeGreaterThan(0);
    declared(await get("/v1/notifications?unread=true&limit=1", owner), "GET /v1/notifications", 200);
    const read = declared(await http().post(`/v1/notifications/${list.body.items[0].id}/read`).set(auth(owner)), "POST /v1/notifications/{id}/read", 200);
    expect(read.body.readAt).not.toBeNull();
    const all = declared(await http().post("/v1/notifications/read-all").set(auth(owner)), "POST /v1/notifications/read-all", 200);
    expect(typeof all.body.updated).toBe("number");
    expect(declared(await get("/v1/notifications/unread-count", owner), "GET /v1/notifications/unread-count", 200).body).toEqual({ count: 0 });
  });
});
