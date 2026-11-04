import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("reel likes, saves and shares", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function creator() {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, "business");
    return s;
  }
  async function reelOf(owner: Session): Promise<string> {
    const a = await prisma.mediaAsset.create({ data: { ownerId: owner.userId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    const res = await http().post("/v1/reels").set(auth(owner)).send({ mediaAssetId: a.id, caption: "engage" });
    expect(res.body.status).toBe("PUBLISHED");
    return res.body.id;
  }
  const like = (s: Session, id: string) => http().put(`/v1/reels/${id}/like`).set(auth(s));
  const unlike = (s: Session, id: string) => http().delete(`/v1/reels/${id}/like`).set(auth(s));
  const save = (s: Session, id: string) => http().put(`/v1/reels/${id}/save`).set(auth(s));
  const unsave = (s: Session, id: string) => http().delete(`/v1/reels/${id}/save`).set(auth(s));
  const row = (id: string) => prisma.reel.findUniqueOrThrow({ where: { id } });
  const users = (n: number) => Promise.all(Array.from({ length: n }, () => t.login()));

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  describe("likes", () => {
    it("is idempotent both ways and moves the counter once", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      expect((await like(me, id)).body).toEqual({ liked: true, likeCount: 1 });
      expect((await like(me, id)).body).toEqual({ liked: true, likeCount: 1 });
      expect((await unlike(me, id)).body).toEqual({ liked: false, likeCount: 0 });
      expect((await unlike(me, id)).body).toEqual({ liked: false, likeCount: 0 });
      expect((await row(id)).likeCount).toBe(0);
    });

    it("needs a signed-in user and a reel the public can see", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      expect((await http().put(`/v1/reels/${id}/like`)).status).toBe(401);
      expect((await like(me, randomUUID())).status).toBe(404);
      await http().delete(`/v1/reels/${id}`).set(auth(owner)).expect(204);
      expect((await like(me, id)).status).toBe(404);
      expect((await unlike(me, id)).status).toBe(404);
    });

    it("shows likedByMe / savedByMe to a signed-in viewer only", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      const other = await t.login();
      await like(me, id);
      await save(me, id);
      expect((await http().get(`/v1/reels/${id}`).set(auth(me))).body).toMatchObject({ likedByMe: true, savedByMe: true, counts: { likes: 1, saves: 1 } });
      expect((await http().get(`/v1/reels/${id}`).set(auth(other))).body).toMatchObject({ likedByMe: false, savedByMe: false });
      expect((await http().get(`/v1/reels/${id}`)).body).not.toHaveProperty("likedByMe");
    });

    // Review Focus 1: double-tap likes, two devices, unlike racing like. Counters must always equal the true row counts.
    it("counters equal the row counts after 50 parallel like / unlike operations by several users", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const fans = await users(5);
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        const fan = fans[i % fans.length];
        // double taps and racing unlikes: each fan fires a burst of mixed PUT / DELETE
        ops.push(i % 3 === 2 ? unlike(fan, id) : like(fan, id));
      }
      expect((await Promise.all(ops)).every((r) => (r as { status: number }).status === 200)).toBe(true);
      const rows = await prisma.reelLike.count({ where: { reelId: id } });
      expect((await row(id)).likeCount).toBe(rows);
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(5);
    });

    it("20 simultaneous likes from one user (two devices, double tap) count once; a final unlike leaves zero", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      await Promise.all(Array.from({ length: 20 }, () => like(me, id)));
      expect((await row(id)).likeCount).toBe(1);
      expect(await prisma.reelLike.count({ where: { reelId: id } })).toBe(1);
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? unlike(me, id) : like(me, id))));
      await unlike(me, id);
      expect((await row(id)).likeCount).toBe(0);
      expect(await prisma.reelLike.count({ where: { reelId: id } })).toBe(0);
    });

    it("the counter never goes below zero even if the row and the counter drifted", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      await like(me, id);
      await prisma.reel.update({ where: { id }, data: { likeCount: 0 } }); // simulated drift
      expect((await unlike(me, id)).body.likeCount).toBe(0);
      expect((await row(id)).likeCount).toBe(0);
    });

    it("limits a user to 120 likes and saves a minute", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      const results = await Promise.all(Array.from({ length: 125 }, () => like(me, id)));
      expect(results.filter((r) => r.status === 429)).toHaveLength(5);
      const saves = await Promise.all(Array.from({ length: 125 }, () => save(me, id)));
      expect(saves.filter((r) => r.status === 429)).toHaveLength(5);
    });

    it("tells the creator about likes, at most once per reel per 10 minutes, and never about their own", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const [a, b] = await users(2);
      await like(owner, id);
      expect(await prisma.notification.count({ where: { userId: owner.userId, type: "reel.like" } })).toBe(0);
      await like(a, id);
      await like(b, id);
      const notes = await prisma.notification.findMany({ where: { userId: owner.userId, type: "reel.like" } });
      expect(notes).toHaveLength(1);
      expect(notes[0].data).toMatchObject({ reelId: id });
      // another reel is its own batch
      const second = await reelOf(owner);
      await like(a, second);
      expect(await prisma.notification.count({ where: { userId: owner.userId, type: "reel.like" } })).toBe(2);
    });
  });

  describe("saves", () => {
    it("saves and unsaves idempotently; counter equals rows under parallel operations", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      expect((await save(me, id)).body).toEqual({ saved: true, saveCount: 1 });
      expect((await save(me, id)).body).toEqual({ saved: true, saveCount: 1 });
      expect((await unsave(me, id)).body).toEqual({ saved: false, saveCount: 0 });
      expect((await unsave(me, id)).body).toEqual({ saved: false, saveCount: 0 });
      const fans = await users(4);
      await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? unsave(fans[i % 4], id) : save(fans[i % 4], id))));
      expect((await row(id)).saveCount).toBe(await prisma.reelSave.count({ where: { reelId: id } }));
    });

    it("lists my saved reels newest save first, paged, without reels that are no longer public", async () => {
      const owner = await creator();
      const ids = [await reelOf(owner), await reelOf(owner), await reelOf(owner), await reelOf(owner)];
      const me = await t.login();
      for (const id of ids) {
        t.clock.advanceSec(2);
        await save(me, id);
      }
      await http().delete(`/v1/reels/${ids[3]}`).set(auth(owner)).expect(204);
      const page1 = await http().get("/v1/me/saved-reels?limit=2").set(auth(me));
      expect(page1.status).toBe(200);
      expect(page1.body.items.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
      expect(page1.body.items[0]).toMatchObject({ savedByMe: true });
      const page2 = await http().get(`/v1/me/saved-reels?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`).set(auth(me));
      expect(page2.body.items.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
      expect(page2.body.nextCursor).toBeNull();
      expect((await http().get("/v1/me/saved-reels?cursor=nope").set(auth(me))).body.error.code).toBe("BAD_CURSOR");
      expect((await http().get("/v1/me/saved-reels")).status).toBe(401);
    });
  });

  describe("shares", () => {
    const share = (s: Session | null, id: string, body: Record<string, unknown> = { channel: "whatsapp" }) => {
      const req = http().post(`/v1/reels/${id}/shares`);
      return (s ? req.set(auth(s)) : req).send(body);
    };

    it("counts a share once per user per reel per IST day; the next day counts again", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      expect((await share(me, id)).body).toEqual({ counted: true, shareCount: 1 });
      expect((await share(me, id, { channel: "copy_link" })).body).toEqual({ counted: false, shareCount: 1 });
      expect((await share(await t.login(), id)).body).toEqual({ counted: true, shareCount: 2 });
      expect(await prisma.reelShare.count({ where: { reelId: id } })).toBe(2);
      t.clock.advance(24 * 3600 * 1000);
      const again = await t.login(me.email);
      expect((await share(again, id)).body.counted).toBe(true);
    });

    it("does not count anonymous shares, and refuses unknown channels and unknown reels", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const res = await share(null, id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ counted: false, shareCount: 0 });
      expect((await row(id)).shareCount).toBe(0);
      expect((await share(await t.login(), id, { channel: "carrier-pigeon" })).status).toBe(400);
      expect((await share(await t.login(), randomUUID())).status).toBe(404);
    });

    it("parallel shares by one user count once", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      await Promise.all(Array.from({ length: 15 }, () => share(me, id)));
      expect((await row(id)).shareCount).toBe(1);
    });

    it("limits a user to 30 shares a minute", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      const results = await Promise.all(Array.from({ length: 33 }, () => share(me, id)));
      expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    });
  });
});

describe("reel comments", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function creator() {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, "business");
    return s;
  }
  async function reelOf(owner: Session): Promise<string> {
    const a = await prisma.mediaAsset.create({ data: { ownerId: owner.userId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    const res = await http().post("/v1/reels").set(auth(owner)).send({ mediaAssetId: a.id, caption: "talk" });
    return res.body.id;
  }
  const comment = (s: Session, reelId: string, body: unknown, parentId?: string) => http().post(`/v1/reels/${reelId}/comments`).set(auth(s)).send({ body, ...(parentId ? { parentId } : {}) });
  const remove = (s: Session, reelId: string, commentId: string) => http().delete(`/v1/reels/${reelId}/comments/${commentId}`).set(auth(s));
  const list = (reelId: string, qs = "") => http().get(`/v1/reels/${reelId}/comments${qs}`);
  const replies = (reelId: string, commentId: string, qs = "") => http().get(`/v1/reels/${reelId}/comments/${commentId}/replies${qs}`);
  const row = (id: string) => prisma.reel.findUniqueOrThrow({ where: { id } });
  const visibleRows = (reelId: string) => prisma.reelComment.count({ where: { reelId, status: "VISIBLE" } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  it("posts a plain-text comment, counts it, and lists it with its author; anonymous readers can see it", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const me = await t.login();
    const res = await comment(me, id, "Great‮ reel​!\n\n\n\nThanks");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ body: "Great reel!\n\nThanks", status: "VISIBLE", parentId: null, replyCount: 0, mine: true, author: { id: me.userId } });
    expect((await row(id)).commentCount).toBe(1);
    const page = await list(id);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({ id: res.body.id, body: "Great reel!\n\nThanks", author: { id: me.userId } });
    expect(page.body.items[0]).not.toHaveProperty("mine");
  });

  it("validates: 1,000 characters at most, not empty once sanitised, signed in, a visible reel", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const me = await t.login();
    expect((await comment(me, id, "x".repeat(1001))).status).toBe(400);
    expect((await comment(me, id, "  ​​  ")).status).toBe(400);
    expect((await comment(me, id, 42)).status).toBe(400);
    expect((await http().post(`/v1/reels/${id}/comments`).send({ body: "hi" })).status).toBe(401);
    expect((await comment(me, randomUUID(), "hi")).status).toBe(404);
    expect((await comment(me, id, "x".repeat(1000))).status).toBe(201);
    expect((await row(id)).commentCount).toBe(1);
  });

  it("replies stay one level deep: a reply to a reply attaches to the top-level comment", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const [a, b, c] = await Promise.all([t.login(), t.login(), t.login()]);
    const top = (await comment(a, id, "top")).body;
    const reply = await comment(b, id, "reply", top.id);
    expect(reply.status).toBe(201);
    expect(reply.body.parentId).toBe(top.id);
    const nested = await comment(c, id, "reply to reply", reply.body.id);
    expect(nested.body.parentId).toBe(top.id);
    expect(await prisma.reelComment.count({ where: { reelId: id, parentId: reply.body.id } })).toBe(0);
    expect((await row(id)).commentCount).toBe(3);
    // list shows only the top-level comment, with its reply count; replies come oldest first from their own endpoint
    const page = await list(id);
    expect(page.body.items.map((x: { id: string }) => x.id)).toEqual([top.id]);
    expect(page.body.items[0].replyCount).toBe(2);
    const r = await replies(id, top.id);
    expect(r.body.items.map((x: { body: string }) => x.body)).toEqual(["reply", "reply to reply"]);
    // a parent from another reel, or one that does not exist, is a 404
    const other = await reelOf(owner);
    expect((await comment(a, other, "x", top.id)).status).toBe(404);
    expect((await comment(a, id, "x", randomUUID())).status).toBe(404);
  });

  it("lists top-level comments newest first in pages", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const me = await t.login();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await comment(me, id, `c${i}`)).body.id);
    const p1 = await list(id, "?limit=2");
    expect(p1.body.items.map((x: { id: string }) => x.id)).toEqual([ids[2], ids[1]]);
    const p2 = await list(id, `?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
    expect(p2.body.nextCursor).toBeNull();
  });

  it("an author edits their own comment; nobody else can", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const [me, other] = await Promise.all([t.login(), t.login()]);
    const c = (await comment(me, id, "first")).body;
    const edit = (s: Session, body: unknown) => http().patch(`/v1/reels/${id}/comments/${c.id}`).set(auth(s)).send({ body });
    const ok = await edit(me, "second​");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ body: "second", editedAt: expect.any(String) });
    expect((await edit(other, "hijack")).status).toBe(404);
    expect((await edit(owner, "creator edit")).status).toBe(404);
    expect((await edit(me, "")).status).toBe(400);
    await remove(me, id, c.id);
    expect((await edit(me, "zombie")).status).toBe(404);
  });

  describe("deleting", () => {
    it("the author deletes their own comment; the counter drops once even if repeated", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const [me, other] = await Promise.all([t.login(), t.login()]);
      const c = (await comment(me, id, "bye")).body;
      expect((await remove(other, id, c.id)).status).toBe(403);
      expect((await row(id)).commentCount).toBe(1);
      expect((await remove(me, id, c.id)).status).toBe(204);
      expect((await remove(me, id, c.id)).status).toBe(204);
      expect((await row(id)).commentCount).toBe(0);
      expect((await list(id)).body.items).toEqual([]);
      expect((await remove(me, id, randomUUID())).status).toBe(404);
    });

    it("the creator of the reel can delete any comment on it", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const me = await t.login();
      const c = (await comment(me, id, "rude")).body;
      expect((await remove(owner, id, c.id)).status).toBe(204);
      expect((await row(id)).commentCount).toBe(0);
      expect(await prisma.reelComment.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "DELETED", deletedBy: owner.userId });
    });

    it("a deleted top-level comment with replies stays as '[deleted]' with its replies; commentCount counts visible comments and replies", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const [a, b] = await Promise.all([t.login(), t.login()]);
      const top = (await comment(a, id, "parent text")).body;
      await comment(b, id, "kept reply", top.id);
      await comment(a, id, "second reply", top.id);
      expect((await row(id)).commentCount).toBe(3);
      await remove(a, id, top.id).expect(204);
      expect((await row(id)).commentCount).toBe(2);
      const page = await list(id);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.items[0]).toMatchObject({ id: top.id, body: "[deleted]", status: "DELETED", author: null, replyCount: 2 });
      expect(JSON.stringify(page.body)).not.toContain("parent text");
      expect((await replies(id, top.id)).body.items.map((x: { body: string }) => x.body)).toEqual(["kept reply", "second reply"]);
      // once its replies are gone too, the placeholder goes
      await prisma.reelComment.updateMany({ where: { parentId: top.id }, data: { status: "DELETED" } });
      expect((await list(id)).body.items).toEqual([]);
    });

    // Review Focus 1: deleted comments with replies, retries, concurrent create + delete.
    it("commentCount equals the visible rows after parallel posts, replies and deletes", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const people = await Promise.all(Array.from({ length: 4 }, () => t.login()));
      const tops = [] as { id: string; userId: string }[];
      for (let i = 0; i < 4; i++) tops.push({ id: (await comment(people[i], id, `top ${i}`)).body.id, userId: people[i].userId });
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 24; i++) ops.push(comment(people[i % 4], id, `reply ${i}`, tops[i % 4].id));
      for (const top of tops.slice(0, 3)) {
        const author = people.find((p) => p.userId === top.userId)!;
        ops.push(remove(author, id, top.id), remove(author, id, top.id), remove(owner, id, top.id));
      }
      await Promise.all(ops);
      expect((await row(id)).commentCount).toBe(await visibleRows(id));
      expect((await row(id)).commentCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("commentsEnabled=false refuses new comments and replies with COMMENTS_DISABLED, keeps what exists readable, and turns back on", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const me = await t.login();
    const c = (await comment(me, id, "before")).body;
    await http().patch(`/v1/reels/${id}`).set(auth(owner)).send({ commentsEnabled: false }).expect(200);
    const refused = await comment(me, id, "after");
    expect([refused.status, refused.body.error.code]).toEqual([403, "COMMENTS_DISABLED"]);
    expect((await comment(me, id, "reply", c.id)).body.error.code).toBe("COMMENTS_DISABLED");
    expect((await list(id)).body.items).toHaveLength(1);
    expect((await row(id)).commentCount).toBe(1);
    expect((await remove(me, id, c.id)).status).toBe(204); // deleting stays possible
    await http().patch(`/v1/reels/${id}`).set(auth(owner)).send({ commentsEnabled: true }).expect(200);
    expect((await comment(me, id, "again")).status).toBe(201);
  });

  it("limits a user to 30 comments a minute", async () => {
    const owner = await creator();
    const id = await reelOf(owner);
    const me = await t.login();
    const results = await Promise.all(Array.from({ length: 33 }, (_, i) => comment(me, id, `spam ${i}`)));
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect((await row(id)).commentCount).toBe(30);
  });

  describe("notifications", () => {
    it("tells the creator about comments, at most once per reel per 10 minutes, never about their own", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const [a, b] = await Promise.all([t.login(), t.login()]);
      await comment(owner, id, "my own reel");
      expect(await prisma.notification.count({ where: { userId: owner.userId, type: "reel.comment" } })).toBe(0);
      await comment(a, id, "nice");
      await comment(b, id, "very nice");
      const notes = await prisma.notification.findMany({ where: { userId: owner.userId, type: "reel.comment" } });
      expect(notes).toHaveLength(1);
      expect(notes[0].data).toMatchObject({ reelId: id });
    });

    it("tells the commenter about a reply (not when they answer themselves), and the creator is not told twice", async () => {
      const owner = await creator();
      const id = await reelOf(owner);
      const [a, b] = await Promise.all([t.login(), t.login()]);
      const top = (await comment(a, id, "question?")).body;
      await comment(a, id, "self reply", top.id);
      expect(await prisma.notification.count({ where: { userId: a.userId, type: "reel.reply" } })).toBe(0);
      await comment(b, id, "answer", top.id);
      const notes = await prisma.notification.findMany({ where: { userId: a.userId, type: "reel.reply" } });
      expect(notes).toHaveLength(1);
      expect(notes[0].data).toMatchObject({ reelId: id, commentId: top.id });
      // the creator replying to a commenter on their own reel: the commenter hears, the creator is not notified of their own action
      const top2 = (await comment(b, id, "q2")).body;
      await comment(owner, id, "creator answers", top2.id);
      expect(await prisma.notification.count({ where: { userId: b.userId, type: "reel.reply" } })).toBe(1);
    });
  });
});
