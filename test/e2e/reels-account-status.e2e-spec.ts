import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import type { Redis } from "ioredis";
import { REDIS } from "../../src/common/redis";
import { UserStatusCache } from "../../src/modules/identity";
import { ProfilesService } from "../../src/modules/users";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("reels of suspended or deleted accounts", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const get = (path: string, s?: Session) => {
    const req = http().get(path).set("X-Forwarded-For", uniqueIp());
    return s ? req.set(auth(s)) : req;
  };
  /** Every id of a paged list, following the cursor to the end. */
  async function all(path: string, s?: Session) {
    const out: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await get(`${path}${path.includes("?") ? "&" : "?"}limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, s);
      expect(res.status).toBe(200);
      out.push(...ids(res.body));
      cursor = res.body.nextCursor;
    } while (cursor);
    return out;
  }
  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);
  /** The account's status as the admin API and a deletion would leave it, with the status cache brought in line the way both do. */
  async function setStatus(userId: string, status: "ACTIVE" | "SUSPENDED" | "DELETED") {
    await prisma.user.update({ where: { id: userId }, data: { status } });
    await t.app.get(UserStatusCache).bust(userId);
  }
  async function reel(creatorId: string, hashtags: string[], caption: string) {
    const a = await prisma.mediaAsset.create({
      data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() },
    });
    return prisma.reel.create({ data: { creatorId, mediaAssetId: a.id, caption, hashtags, status: "PUBLISHED", publishedAt: new Date(t.clock.now().getTime() - 60_000) } });
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  for (const status of ["SUSPENDED", "DELETED"] as const) {
    it(`${status}: their reels and comments vanish from every public read, and come back when the account is active again`, async () => {
      const bad = await t.login();
      const other = await t.login(); // a second creator, so the lists are never empty by accident
      const viewer = await t.login();
      const profiles = t.app.get(ProfilesService);
      await Promise.all([profiles.ensure(bad.userId), profiles.ensure(other.userId), profiles.ensure(viewer.userId)]);
      const handle = (await prisma.profile.findUniqueOrThrow({ where: { userId: bad.userId } })).handle;
      const tag = `st${uniq()}`;
      const word = `zq${uniq()}`;
      const mine = await reel(bad.userId, [tag], `#${tag} ${word}`);
      const theirs = await reel(other.userId, [tag], `#${tag} ${word}`);
      await prisma.follow.createMany({ data: [bad.userId, other.userId].map((followeeId) => ({ followerId: viewer.userId, followeeId })) });
      await prisma.reelSave.create({ data: { userId: viewer.userId, reelId: mine.id } });
      await prisma.reelSave.create({ data: { userId: viewer.userId, reelId: theirs.id } });
      // Comments on the other creator's reel: a top-level one by the account, a reply by it, and a normal one.
      const normal = await http().post(`/v1/reels/${theirs.id}/comments`).set(auth(viewer)).send({ body: "hello" });
      const top = await http().post(`/v1/reels/${theirs.id}/comments`).set(auth(bad)).send({ body: "from the account" });
      const reply = await http().post(`/v1/reels/${theirs.id}/comments`).set(auth(bad)).send({ body: "reply by the account", parentId: normal.body.id });
      expect([normal.status, top.status, reply.status]).toEqual([201, 201, 201]);

      await t.app.get<Redis>(REDIS).del("foryou-global"); // the shared signed-out list is rebuilt with these reels in it
      const surfaces = async () => ({
        single: (await get(`/v1/reels/${mine.id}`)).status,
        profile: ids((await get(`/v1/profiles/${handle}/reels`)).body),
        following: ids((await get("/v1/feed/following", viewer)).body),
        forYouAnon: await all("/v1/feed/for-you"),
        forYou: await all("/v1/feed/for-you", viewer),
        tag: ids((await get(`/v1/hashtags/${tag}/reels`)).body),
        search: ids((await get(`/v1/reels/search?q=${word}`)).body),
        saved: ids((await get("/v1/me/saved-reels", viewer)).body),
        comments: ids((await get(`/v1/reels/${theirs.id}/comments`)).body),
        replies: ids((await get(`/v1/reels/${theirs.id}/comments/${normal.body.id}/replies`)).body),
        replyCount: ((await get(`/v1/reels/${theirs.id}/comments`)).body.items as Array<{ id: string; replyCount: number }>).find((c) => c.id === normal.body.id)?.replyCount,
      });

      // Positive control: with an active account everything shows.
      const before = await surfaces();
      expect(before.single).toBe(200);
      for (const key of ["profile", "following", "forYouAnon", "forYou", "tag", "search", "saved"] as const) expect(before[key]).toContain(mine.id);
      expect(before.comments).toEqual(expect.arrayContaining([top.body.id, normal.body.id]));
      expect(before.replies).toEqual([reply.body.id]);
      expect(before.replyCount).toBe(1);

      await setStatus(bad.userId, status);
      const gone = await surfaces();
      expect(gone.single).toBe(404);
      for (const key of ["profile", "following", "forYouAnon", "forYou", "tag", "search", "saved"] as const) expect([key, gone[key].includes(mine.id)]).toEqual([key, false]);
      // The other creator's reel is untouched everywhere it was.
      for (const key of ["following", "forYouAnon", "forYou", "tag", "search", "saved"] as const) expect([key, gone[key].includes(theirs.id)]).toEqual([key, true]);
      expect(gone.comments).toEqual([normal.body.id]);
      expect(gone.replies).toEqual([]);
      expect(gone.replyCount).toBe(0);

      if (status === "SUSPENDED") {
        await setStatus(bad.userId, "ACTIVE");
        const back = await surfaces();
        expect(back.single).toBe(200);
        for (const key of ["profile", "following", "forYouAnon", "forYou", "tag", "search", "saved"] as const) expect([key, back[key].includes(mine.id)]).toEqual([key, true]);
        expect(back.comments).toEqual(expect.arrayContaining([top.body.id, normal.body.id]));
        expect(back.replies).toEqual([reply.body.id]);
      }
    });
  }
});
