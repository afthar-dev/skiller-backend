import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { ReelNotifier } from "../../src/modules/reels/reel-notifier";
import { RolesService } from "../../src/modules/rbac";
import { ProfilesService } from "../../src/modules/users";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("moderation: hidden, removed and blocked content never shows; blocks and mutes", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  let moderator: Session;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function creator() {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, "business");
    return s;
  }
  const handleOf = async (s: Session) => (await t.app.get(ProfilesService).ensure(s.userId)).handle;
  /** A creator with one published reel carrying its own hashtag and search word. */
  async function withReel(label: string) {
    const owner = await creator();
    const tag = `tag${uniq()}`;
    const word = `word${uniq()}`;
    const a = await prisma.mediaAsset.create({ data: { ownerId: owner.userId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    const res = await http().post("/v1/reels").set(auth(owner)).send({ mediaAssetId: a.id, caption: `${word} #${tag}` });
    expect(res.body.status).toBe("PUBLISHED");
    return { label, owner, handle: await handleOf(owner), id: res.body.id as string, tag, word };
  }
  type Item = Awaited<ReturnType<typeof withReel>>;
  const follow = async (me: Session, who: Session) => {
    await t.app.get(ProfilesService).ensure(me.userId);
    expect((await http().post(`/v1/profiles/${await handleOf(who)}/follow`).set(auth(me))).status).toBe(204);
  };
  const reportAll = async (id: string, type = "REEL", n = 5) => {
    for (const u of await Promise.all(Array.from({ length: n }, () => t.login()))) {
      expect([200, 201]).toContain((await http().post("/v1/reports").set(auth(u)).send({ targetType: type, targetId: id, reason: "SPAM" })).status);
    }
  };
  const block = (me: Session, handle: string) => http().put(`/v1/blocks/${handle}`).set(auth(me));
  const unblock = (me: Session, handle: string) => http().delete(`/v1/blocks/${handle}`).set(auth(me));
  const mute = (me: Session, handle: string) => http().put(`/v1/mutes/${handle}`).set(auth(me));
  const unmute = (me: Session, handle: string) => http().delete(`/v1/mutes/${handle}`).set(auth(me));
  const comment = (s: Session, reelId: string, body: string, parentId?: string) => http().post(`/v1/reels/${reelId}/comments`).set(auth(s)).send({ body, ...(parentId ? { parentId } : {}) });

  /** Every id a surface lists, following nextCursor to the end. */
  async function walk(get: (cursor?: string) => request.Test): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 60; i++) {
      const res = await get(cursor);
      expect(res.status).toBe(200);
      out.push(...res.body.items.map((x: { id: string }) => x.id));
      if (!res.body.nextCursor) return out;
      cursor = res.body.nextCursor;
    }
    throw new Error("list does not end");
  }
  const q = (cursor?: string) => `limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const followingFeed = (me: Session) => walk((c) => http().get(`/v1/feed/following?${q(c)}`).set(auth(me)));
  const forYouFeed = (me: Session | null) => {
    const ip = uniqueIp();
    return walk((c) => {
      const r = http().get(`/v1/feed/for-you?${q(c)}`).set("X-Forwarded-For", ip);
      return me ? r.set(auth(me)) : r;
    });
  };
  const hashtagPage = (me: Session | null, tag: string) =>
    walk((c) => {
      const r = http().get(`/v1/hashtags/${tag}/reels?sort=recent&${q(c)}`).set("X-Forwarded-For", uniqueIp());
      return me ? r.set(auth(me)) : r;
    });
  const searchPage = (me: Session | null, word: string) =>
    walk((c) => {
      const r = http().get(`/v1/reels/search?q=${word}&${q(c)}`).set("X-Forwarded-For", uniqueIp());
      return me ? r.set(auth(me)) : r;
    });
  const profileTab = (me: Session | null, handle: string) =>
    walk((c) => {
      const r = http().get(`/v1/profiles/${handle}/reels?${q(c)}`).set("X-Forwarded-For", uniqueIp());
      return me ? r.set(auth(me)) : r;
    });
  const savedList = (me: Session) => walk((c) => http().get(`/v1/me/saved-reels?${q(c)}`).set(auth(me)));
  const direct = (me: Session | null, id: string) => {
    const r = http().get(`/v1/reels/${id}`).set("X-Forwarded-For", uniqueIp());
    return me ? r.set(auth(me)) : r;
  };
  const commentIds = async (me: Session | null, reelId: string) => {
    const r = http().get(`/v1/reels/${reelId}/comments?limit=100`).set("X-Forwarded-For", uniqueIp());
    return ((me ? await r.set(auth(me)) : await r).body.items ?? []).map((c: { id: string }) => c.id) as string[];
  };
  const notificationRows = async (me: Session) => (await http().get("/v1/notifications?limit=100").set(auth(me))).body.items as Array<{ type: string; data: Record<string, string> }>;

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
    moderator = await t.login();
    await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  it("hidden, removed and blocked reels are absent from the following and for-you feeds, hashtag pages, search, profile tabs, saved lists and direct pages", async () => {
    const [shown, hidden, removed, blocked] = await Promise.all([withReel("shown"), withReel("hidden"), withReel("removed"), withReel("blocked")]);
    const viewer = await t.login();
    const all: Item[] = [shown, hidden, removed, blocked];
    for (const it of all) {
      await follow(viewer, it.owner);
      expect((await http().put(`/v1/reels/${it.id}/save`).set(auth(viewer))).status).toBe(200);
    }
    const surfaces = async () => ({
      following: await followingFeed(viewer),
      forYou: await forYouFeed(viewer),
      saved: await savedList(viewer),
      hashtags: Object.fromEntries(await Promise.all(all.map(async (it) => [it.label, await hashtagPage(viewer, it.tag)] as const))),
      search: Object.fromEntries(await Promise.all(all.map(async (it) => [it.label, await searchPage(viewer, it.word)] as const))),
      profiles: Object.fromEntries(await Promise.all(all.map(async (it) => [it.label, await profileTab(viewer, it.handle)] as const))),
      direct: Object.fromEntries(await Promise.all(all.map(async (it) => [it.label, (await direct(viewer, it.id)).status] as const))),
    });

    // Before: every surface shows every reel (so the checks below prove something).
    const before = await surfaces();
    for (const it of all) {
      expect(before.following).toContain(it.id);
      expect(before.forYou).toContain(it.id);
      expect(before.saved).toContain(it.id);
      expect(before.hashtags[it.label]).toEqual([it.id]);
      expect(before.search[it.label]).toEqual([it.id]);
      expect(before.profiles[it.label]).toEqual([it.id]);
      expect(before.direct[it.label]).toBe(200);
    }

    await reportAll(hidden.id); // 5 reporters: held back
    await reportAll(removed.id);
    expect((await http().post(`/v1/admin/moderation/targets/reel/${removed.id}/uphold`).set(auth(moderator)).send({ note: "no" })).status).toBe(200);
    expect((await block(viewer, blocked.handle)).status).toBe(200); // the very next read must already respect it (cache epoch)

    const after = await surfaces();
    const gone = [hidden, removed, blocked];
    for (const it of gone) {
      for (const list of [after.following, after.forYou, after.saved]) expect(list).not.toContain(it.id);
      expect(after.hashtags[it.label]).toEqual([]);
      expect(after.search[it.label]).toEqual([]);
      expect(after.profiles[it.label]).toEqual([]);
      expect(after.direct[it.label]).toBe(404);
    }
    expect(after.following).toContain(shown.id);
    expect(after.forYou).toContain(shown.id);
    expect(after.saved).toContain(shown.id);
    expect(after.hashtags.shown).toEqual([shown.id]);
    expect(after.search.shown).toEqual([shown.id]);
    expect(after.profiles.shown).toEqual([shown.id]);
    expect(after.direct.shown).toBe(200);
    // Anonymous visitors: hidden and removed are gone too.
    for (const it of [hidden, removed]) {
      expect(await hashtagPage(null, it.tag)).toEqual([]);
      expect(await profileTab(null, it.handle)).toEqual([]);
      expect((await direct(null, it.id)).status).toBe(404);
    }
    // The creator still sees their own hidden reel in the studio, with its status; the blocked creator no longer sees the viewer's side.
    expect((await direct(hidden.owner, hidden.id)).body.status).toBe("HIDDEN");
    expect((await direct(removed.owner, removed.id)).body.status).toBe("REMOVED");
    // Unblocking brings it back at once.
    expect((await unblock(viewer, blocked.handle)).status).toBe(200);
    expect((await direct(viewer, blocked.id)).status).toBe(200);
    expect(await followingFeed(viewer)).not.toContain(blocked.id); // (the block ended the follow)
  });

  it("hidden comments and comments of blocked members are absent from the thread, replies and counts of replies; a blocked member cannot comment, reply, like or save", async () => {
    const host = await withReel("host");
    const fine = await t.login();
    const spam = await t.login();
    const pest = await t.login();
    const viewer = await t.login();
    const top = (await comment(fine, host.id, "a fine comment")).body.id as string;
    const spamTop = (await comment(spam, host.id, "buy now")).body.id as string;
    const pestTop = (await comment(pest, host.id, "pest top")).body.id as string;
    const reply1 = (await comment(fine, host.id, "a reply", top)).body.id as string;
    const reply2 = (await comment(pest, host.id, "pest reply", top)).body.id as string;
    expect((await commentIds(viewer, host.id)).sort()).toEqual([top, spamTop, pestTop].sort());

    await reportAll(spamTop, "REEL_COMMENT");
    expect((await block(viewer, await handleOf(pest))).status).toBe(200);

    expect(await commentIds(viewer, host.id)).toEqual([top]);
    expect((await commentIds(null, host.id)).sort()).toEqual([top, pestTop].sort()); // anonymous: only the hidden one is gone
    const replies = await http().get(`/v1/reels/${host.id}/comments/${top}/replies`).set(auth(viewer));
    expect(replies.body.items.map((c: { id: string }) => c.id)).toEqual([reply1]);
    expect((await http().get(`/v1/reels/${host.id}/comments`).set(auth(viewer))).body.items[0].replyCount).toBe(1);
    expect((await http().get(`/v1/reels/${host.id}/comments/${spamTop}/replies`).set(auth(viewer))).status).toBe(404);
    expect((await http().get(`/v1/reels/${host.id}/comments/${pestTop}/replies`).set(auth(viewer))).status).toBe(404);
    expect(reply2).toBeTruthy();

    // The host blocks the pest: the pest cannot comment on, reply under, like, save or share the host's reel, and cannot even open it.
    expect((await block(host.owner, await handleOf(pest))).status).toBe(200);
    expect((await comment(pest, host.id, "still here?")).status).toBe(404);
    expect((await http().put(`/v1/reels/${host.id}/like`).set(auth(pest))).status).toBe(404);
    expect((await http().put(`/v1/reels/${host.id}/save`).set(auth(pest))).status).toBe(404);
    expect((await direct(pest, host.id)).status).toBe(404);
    expect((await http().get(`/v1/reels/${host.id}/comments`).set(auth(pest))).status).toBe(404);
    // Replying to the blocker's comment elsewhere is refused too.
    const other = await withReel("other");
    const hostComment = (await comment(host.owner, other.id, "host comment")).body.id as string;
    expect((await comment(pest, other.id, "reply to the host", hostComment)).status).toBe(404);
    expect((await comment(fine, other.id, "an ordinary reply", hostComment)).status).toBe(201);
  });

  it("notifications about hidden or removed reels and comments, and from blocked members, are not listed; none is created between blocked members", async () => {
    const mine = await withReel("mine");
    const me = mine.owner;
    const hidingFan = await t.login();
    const blockedFan = await t.login();
    const spammer = await t.login();

    const commentByBlocked = (await comment(blockedFan, mine.id, "hello from a soon-blocked member")).body.id as string;
    const second = await withReel("second");
    const commentBySpammer = (await comment(spammer, second.id, "spam spam")).body.id as string;
    const third = await withReel("third");
    expect((await http().put(`/v1/reels/${third.id}/like`).set(auth(hidingFan))).status).toBe(200);
    const fourth = await withReel("fourth");
    await comment(hidingFan, fourth.id, "ordinary comment");

    const types = async (s: Session) => (await notificationRows(s)).map((n) => `${n.type}:${n.data?.reelId ?? ""}`);
    expect(await types(me)).toContain(`reel.comment:${mine.id}`);
    expect(await types(second.owner)).toContain(`reel.comment:${second.id}`);
    expect(await types(third.owner)).toContain(`reel.like:${third.id}`);
    expect(await types(fourth.owner)).toContain(`reel.comment:${fourth.id}`);

    expect((await block(me, await handleOf(blockedFan))).status).toBe(200);
    expect(await types(me)).not.toContain(`reel.comment:${mine.id}`);
    await reportAll(commentBySpammer, "REEL_COMMENT"); // the comment is hidden: nobody hears about it any more
    expect(await types(second.owner)).not.toContain(`reel.comment:${second.id}`);
    await reportAll(third.id); // the reel itself is hidden
    expect(await types(third.owner)).not.toContain(`reel.like:${third.id}`);
    expect(await types(fourth.owner)).toContain(`reel.comment:${fourth.id}`); // untouched ones stay
    expect(commentByBlocked && commentBySpammer).toBeTruthy();

    // Between blocked members nothing is sent in the first place.
    const notifier = t.app.get(ReelNotifier);
    const before = await prisma.notification.count({ where: { userId: me.userId } });
    await notifier.notifyUser(me.userId, { type: "reel.reply", title: "x", body: "y" }, blockedFan.userId);
    await notifier.notifyCreatorOfActivity("like", { id: mine.id, creatorId: me.userId }, blockedFan.userId, { type: "reel.like", title: "x", body: "y" });
    expect(await prisma.notification.count({ where: { userId: me.userId } })).toBe(before);
    await notifier.notifyUser(me.userId, { type: "reel.reply", title: "x", body: "y" }, hidingFan.userId);
    expect(await prisma.notification.count({ where: { userId: me.userId } })).toBe(before + 1);
  });

  describe("blocks", () => {
    it("end the follow both ways with the counters fixed, refuse new follows either way (FOLLOW_BLOCKED), and work symmetrically", async () => {
      const a = await t.login();
      const b = await t.login();
      const ha = await handleOf(a);
      const hb = await handleOf(b);
      expect((await http().post(`/v1/profiles/${hb}/follow`).set(auth(a))).status).toBe(204);
      expect((await http().post(`/v1/profiles/${ha}/follow`).set(auth(b))).status).toBe(204);
      const counts = async () => {
        const [pa, pb] = await Promise.all([prisma.profile.findUniqueOrThrow({ where: { userId: a.userId } }), prisma.profile.findUniqueOrThrow({ where: { userId: b.userId } })]);
        return [pa.followersCount, pa.followingCount, pb.followersCount, pb.followingCount];
      };
      expect(await counts()).toEqual([1, 1, 1, 1]);

      expect((await block(a, hb)).status).toBe(200);
      expect((await block(a, hb)).status).toBe(200); // idempotent
      expect(await prisma.follow.count({ where: { OR: [{ followerId: a.userId, followeeId: b.userId }, { followerId: b.userId, followeeId: a.userId }] } })).toBe(0);
      expect(await counts()).toEqual([0, 0, 0, 0]);
      for (const [who, handle] of [[a, hb], [b, ha]] as const) {
        const res = await http().post(`/v1/profiles/${handle}/follow`).set(auth(who));
        expect([res.status, res.body.error.code]).toEqual([403, "FOLLOW_BLOCKED"]);
      }
      expect(await counts()).toEqual([0, 0, 0, 0]);
      // Either side sees none of the other's reels.
      const ra = await withReel("ra");
      const reelOfB = await withReel("rb");
      expect((await block(ra.owner, reelOfB.handle)).status).toBe(200);
      expect((await direct(ra.owner, reelOfB.id)).status).toBe(404);
      expect((await direct(reelOfB.owner, ra.id)).status).toBe(404);
      expect(await profileTab(reelOfB.owner, ra.handle)).toEqual([]);
      expect(await hashtagPage(reelOfB.owner, ra.tag)).toEqual([]);
      expect(await searchPage(ra.owner, reelOfB.word)).toEqual([]);

      expect((await unblock(a, hb)).status).toBe(200);
      expect((await http().post(`/v1/profiles/${hb}/follow`).set(auth(a))).status).toBe(204);
      expect((await block(a, ha)).status).toBe(400); // yourself
      expect((await block(a, "nobody-has-this-handle")).status).toBe(404);
      expect((await http().put(`/v1/blocks/${hb}`)).status).toBe(401);
    });

    it("caches the relations per viewer for 60 s under an epoch key that every change bumps", async () => {
      const a = await t.login();
      const b = await t.login();
      const hb = await handleOf(b);
      await handleOf(a);
      const epochOf = async (s: Session) => Number(await redis.get(`rel:epoch:${s.userId}`)) || 0;
      const before = [await epochOf(a), await epochOf(b)];
      await followingFeed(a); // fills a's cache
      await block(a, hb);
      expect([await epochOf(a), await epochOf(b)]).toEqual([before[0] + 1, before[1] + 1]); // both sides: a block works both ways
      await followingFeed(a); // reads through and caches under the new epoch
      const cached = await redis.keys(`rel:${a.userId}:${before[0] + 1}`);
      expect(cached).toHaveLength(1);
      const ttl = await redis.ttl(cached[0]);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      await unblock(a, hb);
      expect(await epochOf(a)).toBe(before[0] + 2);
    });

    it("lists my blocks and mutes (newest first, paged, with handles) and needs sign-in", async () => {
      const me = await t.login();
      const people = [await withReel("p1"), await withReel("p2"), await withReel("p3")];
      for (const p of people) {
        const blocked = await block(me, p.handle);
        expect(blocked.status).toBe(200);
        expect(blocked.body).toEqual({ blocked: true });
        const muted = await mute(me, p.handle);
        expect(muted.status).toBe(200);
        expect(muted.body).toEqual({ muted: true });
      }
      const page1 = await http().get("/v1/me/blocks?limit=2").set(auth(me));
      expect(page1.body).toMatchObject({ items: expect.any(Array), nextCursor: expect.any(String) });
      expect(page1.body.items[0]).toMatchObject({ id: expect.any(String), handle: people[2].handle, displayName: expect.any(String), since: expect.stringMatching(/^d{4}-d{2}-d{2}T/) });
      const mutesPage = await http().get("/v1/me/mutes").set(auth(me));
      expect(mutesPage.body).toMatchObject({ items: expect.any(Array), nextCursor: null });
      expect(mutesPage.body.items[0]).toMatchObject({ id: expect.any(String), handle: expect.any(String), displayName: expect.any(String), since: expect.any(String) });
      expect(page1.body.items.map((i: { handle: string }) => i.handle)).toEqual([people[2].handle, people[1].handle]);
      const page2 = await http().get(`/v1/me/blocks?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`).set(auth(me));
      expect(page2.body.items.map((i: { handle: string }) => i.handle)).toEqual([people[0].handle]);
      expect(page2.body.nextCursor).toBeNull();
      expect((await http().get("/v1/me/mutes").set(auth(me))).body.items.map((i: { handle: string }) => i.handle)).toEqual(people.map((p) => p.handle).reverse());
      const unmuted = await unmute(me, people[0].handle);
      expect(unmuted.status).toBe(200);
      expect(unmuted.body).toEqual({ muted: false });
      const unblocked = await unblock(me, people[0].handle);
      expect(unblocked.status).toBe(200);
      expect(unblocked.body).toEqual({ blocked: false });
      await block(me, people[0].handle);
      expect((await http().get("/v1/me/mutes").set(auth(me))).body.items).toHaveLength(2);
      expect((await http().get("/v1/me/blocks")).status).toBe(401);
      // The blocked members are not told, and do not see me in theirs.
      expect((await http().get("/v1/me/blocks").set(auth(people[0].owner))).body.items).toEqual([]);
    });
  });

  describe("mutes", () => {
    it("only hide the muted creator from the muter's feeds, hashtag pages and search: profile tab, direct page, comments, follows and the muted creator's own view are untouched", async () => {
      const muted = await withReel("muted");
      const kept = await withReel("kept");
      const me = await t.login();
      await follow(me, muted.owner);
      await follow(me, kept.owner);
      const commenter = await t.login();
      const c = (await comment(muted.owner, kept.id, "from the muted one")).body.id as string;
      expect(commenter).toBeTruthy();
      expect(await followingFeed(me)).toEqual(expect.arrayContaining([muted.id, kept.id]));

      expect((await mute(me, muted.handle)).status).toBe(200);
      expect((await mute(me, muted.handle)).status).toBe(200); // idempotent
      expect((await mute(me, await handleOf(me))).status).toBe(400);
      expect(await followingFeed(me)).toEqual(expect.arrayContaining([kept.id]));
      expect(await followingFeed(me)).not.toContain(muted.id);
      expect(await forYouFeed(me)).not.toContain(muted.id);
      expect(await hashtagPage(me, muted.tag)).toEqual([]);
      expect(await searchPage(me, muted.word)).toEqual([]);
      // Untouched:
      expect(await profileTab(me, muted.handle)).toEqual([muted.id]);
      expect((await direct(me, muted.id)).status).toBe(200);
      expect(await commentIds(me, kept.id)).toEqual([c]);
      expect(await prisma.follow.count({ where: { followerId: me.userId, followeeId: muted.owner.userId } })).toBe(1);
      expect((await followingFeed(muted.owner)).length).toBeGreaterThanOrEqual(0);
      expect(await hashtagPage(muted.owner, muted.tag)).toEqual([muted.id]);
      expect(await hashtagPage(commenter, muted.tag)).toEqual([muted.id]); // other members still see it

      expect((await unmute(me, muted.handle)).status).toBe(200);
      expect(await followingFeed(me)).toContain(muted.id);
      expect(await hashtagPage(me, muted.tag)).toEqual([muted.id]);
    });
  });

  it("hands a saved reel list through the same filter: saves of reels that later become hidden are skipped without losing the page size", async () => {
    const viewer = await t.login();
    const reels = await Promise.all(Array.from({ length: 4 }, (_, i) => withReel(`s${i}`)));
    for (const r of reels) expect((await http().put(`/v1/reels/${r.id}/save`).set(auth(viewer))).status).toBe(200);
    reels.sort((a, b) => (a.id < b.id ? -1 : 1)); // saves share one fake-clock instant: the list orders by reel id then
    await reportAll(reels[3].id); // first in the list, hidden
    const page = await http().get("/v1/me/saved-reels?limit=2").set(auth(viewer));
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([reels[2].id, reels[1].id]);
    const next = await http().get(`/v1/me/saved-reels?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`).set(auth(viewer));
    expect(next.body.items.map((i: { id: string }) => i.id)).toEqual([reels[0].id]);
  });
});
