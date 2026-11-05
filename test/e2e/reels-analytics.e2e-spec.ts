import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { addDays, istDateOf, istDayRange } from "../../src/modules/billing";
import { ReelViewFlusher } from "../../src/modules/reels/reel-view-flusher";
import { ProfilesService } from "../../src/modules/users";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const deviceId = () => randomBytes(16).toString("base64url");

describe("reel analytics (creator studio) and the course-link beacon", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let flusher: ReelViewFlusher;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const today = () => istDateOf(t.clock.now());

  async function creator(plan: string) {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, plan);
    return s;
  }
  async function reel(creatorId: string, over: Record<string, unknown> = {}, durationSec = 30) {
    const a = await prisma.mediaAsset.create({
      data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec, attachedAt: new Date() },
    });
    return prisma.reel.create({ data: { creatorId, mediaAssetId: a.id, caption: `reel ${uniq()}`, hashtags: [], status: "PUBLISHED", publishedAt: new Date(), ...over } });
  }
  const day = (reelId: string, date: string, views: number, watchSec: number, uniqueViewers: number, linkClicks = 0) =>
    prisma.reelViewDaily.create({ data: { reelId, day: date, views, watchSec, uniqueViewers, linkClicks } });
  const click = (reelId: string, opts: { cookie?: string; token?: string; ip?: string } = {}) => {
    const req = http().post(`/v1/reels/${reelId}/link-click`).set("X-Forwarded-For", opts.ip ?? uniqueIp());
    if (opts.cookie) req.set("Cookie", `skiller_did=${opts.cookie}`);
    if (opts.token) req.set("Authorization", `Bearer ${opts.token}`);
    return req.send({});
  };
  const account = (s: Session, query = "") => http().get(`/v1/studio/reels/analytics${query}`).set(auth(s));
  const one = (s: Session, id: string, query = "") => http().get(`/v1/studio/reels/${id}/analytics${query}`).set(auth(s));

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    flusher = t.app.get(ReelViewFlusher);
    await flusher.flush();
  });
  afterAll(() => t?.close());

  describe("POST /v1/reels/:id/link-click", () => {
    it("counts one click per viewer per reel per IST day, flushed into the daily row; the creator's own click and a reel without a link do not count", async () => {
      const owner = await creator("free");
      const linked = await reel(owner.userId, { linkedCourseId: randomUUID() });
      const unlinked = await reel(owner.userId);
      const did = deviceId();
      const first = await click(linked.id, { cookie: did });
      expect([first.status, first.body]).toEqual([202, { counted: true }]);
      expect((await click(linked.id, { cookie: did })).body).toEqual({ counted: false });
      expect((await click(linked.id, { cookie: deviceId() })).body).toEqual({ counted: true });
      const member = await t.login();
      expect((await click(linked.id, { token: member.accessToken })).body).toEqual({ counted: true });
      expect((await click(linked.id, { token: member.accessToken })).body).toEqual({ counted: false });
      expect((await click(linked.id, { token: owner.accessToken })).body).toEqual({ counted: false });
      expect((await click(unlinked.id, { cookie: deviceId() })).body).toEqual({ counted: false });
      expect((await click(randomUUID())).status).toBe(404);
      const hidden = await reel(owner.userId, { linkedCourseId: randomUUID(), status: "HIDDEN" });
      expect((await click(hidden.id)).status).toBe(404);

      await flusher.flush();
      await flusher.flush(); // nothing pending: no double count
      expect(await prisma.reelViewDaily.findUnique({ where: { reelId_day: { reelId: linked.id, day: today() } } })).toMatchObject({ linkClicks: 3, views: 0 });

      // the next IST day the same device counts again
      t.clock.advance(86_400_000);
      expect((await click(linked.id, { cookie: did })).body).toEqual({ counted: true });
      await flusher.flush();
      expect((await prisma.reelViewDaily.findUnique({ where: { reelId_day: { reelId: linked.id, day: today() } } }))?.linkClicks).toBe(1);
    });

    it("clicks and views of the same day land in one row", async () => {
      const owner = await creator("free");
      const r = await reel(owner.userId, { linkedCourseId: randomUUID() });
      const did = deviceId();
      expect((await http().post(`/v1/reels/${r.id}/views`).set("X-Forwarded-For", uniqueIp()).set("Cookie", `skiller_did=${did}`).send({ watchedSec: 10 })).body).toEqual({ counted: true });
      expect((await click(r.id, { cookie: did })).body).toEqual({ counted: true });
      await flusher.flush();
      expect(await prisma.reelViewDaily.findUnique({ where: { reelId_day: { reelId: r.id, day: today() } } })).toMatchObject({ views: 1, linkClicks: 1 });
    });
  });

  describe("GET /v1/studio/reels/:id/analytics", () => {
    it("is the owner's only: 401 anonymous, 404 for anyone else, for a deleted reel and for an unknown id", async () => {
      const owner = await creator("pro");
      const r = await reel(owner.userId);
      expect((await http().get(`/v1/studio/reels/${r.id}/analytics`)).status).toBe(401);
      expect((await one(await creator("pro"), r.id)).status).toBe(404);
      expect((await one(owner, randomUUID())).status).toBe(404);
      await prisma.reel.update({ where: { id: r.id }, data: { status: "DELETED" } });
      expect((await one(owner, r.id)).status).toBe(404);
    });

    it("standard plan: totals, live counters and a dense daily series in IST days; average watch is watch seconds over views x duration", async () => {
      const owner = await creator("pro");
      const r = await reel(owner.userId, { likeCount: 7, commentCount: 3, saveCount: 2, shareCount: 1 }, 30);
      const d0 = today();
      const d1 = addDays(d0, -1);
      const old = addDays(d0, -40);
      await day(r.id, d1, 10, 100, 8, 2);
      await day(r.id, d0, 5, 60, 4, 1);
      await day(r.id, old, 99, 99, 99, 99); // outside the range
      const res = await one(owner, r.id, `?from=${addDays(d0, -2)}&to=${d0}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        reelId: r.id,
        range: { from: addDays(d0, -2), to: d0 },
        upgradeRequired: false,
        totals: { views: 15, uniqueViewers: 12, watchSec: 160, avgWatchPct: 35.6, linkClicks: 3, newFollowers: 0 },
        live: { likes: 7, comments: 3, saves: 2, shares: 1 },
      });
      expect(res.body.daily).toEqual([
        { date: addDays(d0, -2), views: 0, watchSec: 0, linkClicks: 0 },
        { date: d1, views: 10, watchSec: 100, linkClicks: 2 },
        { date: d0, views: 5, watchSec: 60, linkClicks: 1 },
      ]);
    });

    it("basic plan: totals only, with upgradeRequired and no daily series", async () => {
      const owner = await creator("free");
      const r = await reel(owner.userId);
      await day(r.id, today(), 4, 40, 3, 1);
      const res = await one(owner, r.id);
      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(true);
      expect(res.body.totals).toMatchObject({ views: 4, watchSec: 40, linkClicks: 1 });
      expect(res.body.daily).toBeUndefined();
    });

    it("a reel nobody watched reports zeros, not NaN", async () => {
      const owner = await creator("pro");
      const res = await one(owner, (await reel(owner.userId)).id);
      expect(res.body.totals).toMatchObject({ views: 0, uniqueViewers: 0, watchSec: 0, avgWatchPct: 0, linkClicks: 0 });
    });
  });

  describe("GET /v1/studio/reels/analytics", () => {
    it("sums every reel of the creator over the range and lists the top reels (standard plan); other creators' reels are not counted", async () => {
      const owner = await creator("business");
      const a = await reel(owner.userId, { likeCount: 4, commentCount: 1, saveCount: 1, shareCount: 0 }, 30);
      const b = await reel(owner.userId, { likeCount: 1, commentCount: 0, saveCount: 0, shareCount: 2 }, 60);
      const gone = await reel(owner.userId, { status: "DELETED", likeCount: 50 }, 30);
      const other = await creator("pro");
      const foreign = await reel(other.userId);
      const d0 = today();
      const d1 = addDays(d0, -1);
      await day(a.id, d1, 10, 100, 8, 2);
      await day(a.id, d0, 5, 60, 4, 1);
      await day(b.id, d0, 20, 600, 15, 0);
      await day(gone.id, d0, 3, 30, 3, 0);
      await day(foreign.id, d0, 1000, 1000, 1000, 1000);

      const res = await account(owner, `?from=${d1}&to=${d0}`);
      expect(res.status).toBe(200);
      // watch seconds 100 + 60 + 600 + 30 over the seconds the viewers could have watched: 15 x 30 + 20 x 60 + 3 x 30
      expect(res.body).toMatchObject({
        range: { from: d1, to: d0 },
        upgradeRequired: false,
        totals: { views: 38, uniqueViewers: 30, watchSec: 790, avgWatchPct: 45.4, linkClicks: 3, newFollowers: 0 },
        live: { likes: 5, comments: 1, saves: 1, shares: 2 },
      });
      expect(res.body.daily).toEqual([
        { date: d1, views: 10, watchSec: 100, linkClicks: 2 },
        { date: d0, views: 28, watchSec: 690, linkClicks: 1 },
      ]);
      expect(res.body.topReels.map((r: { reelId: string }) => r.reelId)).toEqual([b.id, a.id]);
      expect(res.body.topReels[0]).toMatchObject({ reelId: b.id, views: 20, avgWatchPct: 50, likes: 1, comments: 0, saves: 0, shares: 2, linkClicks: 0 });
    });

    it("defaults to the last 30 IST days; the basic plan gets totals only", async () => {
      const owner = await creator("free");
      const r = await reel(owner.userId);
      await day(r.id, today(), 2, 20, 2, 0);
      await day(r.id, addDays(today(), -29), 3, 30, 3, 0);
      await day(r.id, addDays(today(), -30), 7, 70, 7, 0);
      const res = await account(owner);
      expect(res.status).toBe(200);
      expect(res.body.range).toEqual({ from: addDays(today(), -29), to: today() });
      expect(res.body.totals.views).toBe(5);
      expect(res.body.upgradeRequired).toBe(true);
      expect(res.body.daily).toBeUndefined();
      expect(res.body.topReels).toBeUndefined();
    });

    it("counts IST day buckets: a view just after IST midnight belongs to the new day", async () => {
      const { to } = istDayRange(today());
      // 23:59:50 IST: the view lands in today's bucket; 20 s later in tomorrow's (sign in after the jump: tokens are issued against the same clock)
      t.clock.advance(to.getTime() - 10_000 - t.clock.now().getTime());
      const owner = await creator("pro");
      const r = await reel(owner.userId, {}, 30);
      const send = (cookie: string) => http().post(`/v1/reels/${r.id}/views`).set("X-Forwarded-For", uniqueIp()).set("Cookie", `skiller_did=${cookie}`).send({ watchedSec: 5 });
      expect((await send(deviceId())).body).toEqual({ counted: true });
      const first = today();
      t.clock.advance(20_000);
      expect((await send(deviceId())).body).toEqual({ counted: true });
      await flusher.flush();
      const res = await account(owner, `?from=${first}&to=${today()}`);
      expect(res.body.daily).toEqual([
        { date: first, views: 1, watchSec: 5, linkClicks: 0 },
        { date: today(), views: 1, watchSec: 5, linkClicks: 0 },
      ]);
    });

    it("newFollowers counts follows of the creator inside the range only", async () => {
      const owner = await creator("pro");
      const profiles = t.app.get(ProfilesService);
      const handle = (await profiles.ensure(owner.userId)).handle;
      const fans = await Promise.all([t.login(), t.login(), t.login()]);
      for (const f of fans) {
        await profiles.ensure(f.userId);
        expect((await http().post(`/v1/profiles/${handle}/follow`).set(auth(f))).status).toBe(204);
      }
      const d0 = today();
      const at = (d: string) => new Date(istDayRange(d).from.getTime() + 3_600_000);
      const move = (fan: Session, d: string) => prisma.follow.update({ where: { followerId_followeeId: { followerId: fan.userId, followeeId: owner.userId } }, data: { createdAt: at(d) } });
      await move(fans[0], d0);
      await move(fans[1], addDays(d0, -1));
      await move(fans[2], addDays(d0, -9));
      expect((await account(owner, `?from=${addDays(d0, -1)}&to=${d0}`)).body.totals.newFollowers).toBe(2);
      expect((await account(owner, `?from=${d0}&to=${d0}`)).body.totals.newFollowers).toBe(1);
      const r = await reel(owner.userId);
      const res = await one(owner, r.id, `?from=${addDays(d0, -1)}&to=${d0}`);
      expect(res.body.totals.newFollowers).toBe(2); // the creator's, not attributed to this reel
      expect(res.body.newFollowersScope).toBe("creator");
    });

    it("validates the range: real dates, from not after to, at most 366 days; needs a signed-in user", async () => {
      const owner = await creator("pro");
      expect((await http().get("/v1/studio/reels/analytics")).status).toBe(401);
      for (const q of ["?from=2026-02-30", "?from=yesterday", `?from=${today()}&to=${addDays(today(), -1)}`, `?from=${addDays(today(), -366)}&to=${today()}`, "?extra=1"]) {
        const res = await account(owner, q);
        expect([q, res.status, res.body.error.code]).toEqual([q, 400, "VALIDATION_FAILED"]);
      }
      expect((await account(owner, `?from=${addDays(today(), -365)}&to=${today()}`)).status).toBe(200);
      const none = await account(await t.login());
      expect([none.status, none.body.totals.views]).toEqual([200, 0]);
    });
  });
});
