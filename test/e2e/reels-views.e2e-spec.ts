import { randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { istDateOf } from "../../src/modules/billing";
import { ReelViewFlusher } from "../../src/modules/reels/reel-view-flusher";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const deviceId = () => randomBytes(16).toString("base64url");
const PENDING = "reelviews:pending";

describe("reel views", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  let flusher: ReelViewFlusher;
  const http = () => request(t.app.getHttpServer());
  const today = () => istDateOf(t.clock.now());

  /** A PUBLISHED reel with a 30 s video, owned by `creatorId`. */
  async function reel(creatorId: string, status: "PUBLISHED" | "HIDDEN" | "PROCESSING" = "PUBLISHED") {
    const a = await prisma.mediaAsset.create({
      data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30, attachedAt: new Date() },
    });
    return prisma.reel.create({ data: { creatorId, mediaAssetId: a.id, caption: "", hashtags: [], status, publishedAt: status === "PUBLISHED" ? new Date() : null } });
  }
  const view = (reelId: string, body: unknown, opts: { ip?: string; cookie?: string; ua?: string; token?: string } = {}) => {
    const req = http().post(`/v1/reels/${reelId}/views`).set("X-Forwarded-For", opts.ip ?? uniqueIp());
    if (opts.cookie) req.set("Cookie", `skiller_did=${opts.cookie}`);
    if (opts.ua) req.set("User-Agent", opts.ua);
    if (opts.token) req.set("Authorization", `Bearer ${opts.token}`);
    return req.send(body as object);
  };
  const row = (id: string) => prisma.reel.findUniqueOrThrow({ where: { id } });
  const daily = (reelId: string) => prisma.reelViewDaily.findMany({ where: { reelId }, orderBy: { day: "asc" } });
  const setCookie = (res: request.Response) => ((res.headers["set-cookie"] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith("skiller_did="));

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
    flusher = t.app.get(ReelViewFlusher);
    await flusher.flush(); // other suites may have left counts behind; start from empty
  });
  afterAll(() => t?.close());

  describe("the beacon", () => {
    it("counts a view after 3 s, once: replaying the beacon (same device, same day) changes nothing", async () => {
      const owner = await t.login();
      const r = await reel(owner.userId);
      const did = deviceId();
      const ip = uniqueIp();
      expect((await view(r.id, { watchedSec: 2.9 }, { cookie: did, ip })).body).toEqual({ counted: false });
      const first = await view(r.id, { watchedSec: 3 }, { cookie: did, ip });
      expect([first.status, first.body]).toEqual([202, { counted: true }]);
      for (let i = 0; i < 5; i++) expect((await view(r.id, { watchedSec: 12 }, { cookie: did, ip })).body).toEqual({ counted: false });
      // Not even from another address: the device is the viewer.
      expect((await view(r.id, { watchedSec: 12 }, { cookie: did })).body).toEqual({ counted: false });
      await flusher.flush();
      // Later beacons still add what was watched beyond the earlier ones (3 s, then 12 s: 12 in all), but never count a second view.
      expect(await row(r.id)).toMatchObject({ viewCount: 1, watchSecTotal: 12 });
    });

    it("accumulates watch time over beacons: 3 s, 10 s, 8 s (a seek back adds nothing), 30 s, 45 s (capped at the duration) is 30 s and one view", async () => {
      const owner = await t.login();
      const r = await reel(owner.userId);
      const viewer = await t.login();
      const beacon = (watchedSec: number) => view(r.id, { watchedSec }, { token: viewer.accessToken });
      const counted: boolean[] = [];
      for (const w of [3, 10, 8, 30, 45]) counted.push((await beacon(w)).body.counted);
      expect(counted).toEqual([true, false, false, false, false]);
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 1, watchSecTotal: 30 });
      expect(await daily(r.id)).toMatchObject([{ views: 1, watchSec: 30 }]);

      // A cookie-less browser and the cookie it was handed are one viewer too: 5 s, then 9 s with the cookie is 9 s, not 14.
      const ip = uniqueIp();
      const first = await view(r.id, { watchedSec: 5 }, { ip, ua: "wt/1" });
      const issued = /^skiller_did=([^;]+);/.exec(setCookie(first)!)![1];
      await view(r.id, { watchedSec: 9 }, { cookie: issued, ip: uniqueIp(), ua: "other" });
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 2, watchSecTotal: 30 + 9 });
    });

    it("caps the watched seconds at the reel's duration and rounds down", async () => {
      const r = await reel((await t.login()).userId);
      expect((await view(r.id, { watchedSec: 500.7 }, { cookie: deviceId() })).body).toEqual({ counted: true });
      expect((await view(r.id, { watchedSec: 12.9 }, { cookie: deviceId() })).body).toEqual({ counted: true });
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 2, watchSecTotal: 30 + 12 });
    });

    it("rejects a body that is not a number of seconds, and counts nothing for a reel that is not published", async () => {
      const owner = await t.login();
      const r = await reel(owner.userId);
      for (const body of [{}, { watchedSec: "9" }, { watchedSec: -1 }, { watchedSec: null }, { watchedSec: 5, extra: 1 }]) expect((await view(r.id, body)).status).toBe(400);
      for (const status of ["HIDDEN", "PROCESSING"] as const) expect((await view((await reel(owner.userId, status)).id, { watchedSec: 10 })).status).toBe(404);
      expect((await view(randomUUID(), { watchedSec: 10 })).status).toBe(404);
    });

    it("does not count the creator watching their own reel", async () => {
      const owner = await t.login();
      const r = await reel(owner.userId);
      expect((await view(r.id, { watchedSec: 20 }, { token: owner.accessToken })).body).toEqual({ counted: false });
      await flusher.flush();
      expect((await row(r.id)).viewCount).toBe(0);
    });
  });

  describe("who the viewer is", () => {
    it("issues an anonymous device id cookie when missing (httpOnly, SameSite=Lax, one year, Secure outside development) and replaces a malformed one", async () => {
      const r = await reel((await t.login()).userId);
      const res = await view(r.id, { watchedSec: 1 });
      const cookie = setCookie(res)!;
      expect(cookie).toMatch(/^skiller_did=[A-Za-z0-9_-]{22};/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Max-Age=31536000");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
      const bad = await view(r.id, { watchedSec: 1 }, { cookie: "not a device id!!" });
      expect(setCookie(bad)).toMatch(/^skiller_did=[A-Za-z0-9_-]{22};/);
      expect(setCookie(bad)).not.toContain("not a device");
      // A good cookie is kept as it is.
      expect(setCookie(await view(r.id, { watchedSec: 1 }, { cookie: deviceId() }))).toBeUndefined();
    });

    it("without a cookie the viewer is the address and browser: replays are deduped, and the cookie it is given is already marked as seen", async () => {
      const r = await reel((await t.login()).userId);
      const ip = uniqueIp();
      const first = await view(r.id, { watchedSec: 5 }, { ip, ua: "curl/8" });
      expect(first.body).toEqual({ counted: true });
      expect((await view(r.id, { watchedSec: 5 }, { ip, ua: "curl/8" })).body).toEqual({ counted: false });
      const issued = /^skiller_did=([^;]+);/.exec(setCookie(first)!)![1];
      expect((await view(r.id, { watchedSec: 5 }, { cookie: issued, ip: uniqueIp(), ua: "other" })).body).toEqual({ counted: false });
      // Another browser behind the same address is another viewer.
      expect((await view(r.id, { watchedSec: 5 }, { ip, ua: "curl/9" })).body).toEqual({ counted: true });
    });

    it("a signed-in viewer counts once per reel per day however many devices they use, and is remembered in ReelSeen", async () => {
      const owner = await t.login();
      const r = await reel(owner.userId);
      const viewer = await t.login();
      const a = await view(r.id, { watchedSec: 15 }, { token: viewer.accessToken, cookie: deviceId() });
      expect(a.body).toEqual({ counted: true });
      expect(setCookie(a)).toBeUndefined(); // signed in: no device id needed
      expect((await view(r.id, { watchedSec: 15 }, { token: viewer.accessToken, cookie: deviceId() })).body).toEqual({ counted: false });
      expect((await view(r.id, { watchedSec: 30 }, { token: viewer.accessToken })).body).toEqual({ counted: false });
      await flusher.flush();
      expect((await row(r.id)).viewCount).toBe(1);
      const seen = await prisma.reelSeen.findUniqueOrThrow({ where: { userId_reelId: { userId: viewer.userId, reelId: r.id } } });
      expect(seen.watchedPct).toBe(100); // the latest beacon: all 30 s
      expect(seen.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // Another viewer on the same device is a second view.
      const other = await t.login();
      expect((await view(r.id, { watchedSec: 15 }, { token: other.accessToken })).body).toEqual({ counted: true });
      // A revoked or garbage token is just an anonymous viewer, not an error.
      expect((await view(r.id, { watchedSec: 15 }, { token: "garbage", cookie: deviceId() })).status).toBe(202);
    });

    it("counts again the next IST day", async () => {
      const r = await reel((await t.login()).userId);
      const did = deviceId();
      const ip = uniqueIp();
      expect((await view(r.id, { watchedSec: 10 }, { cookie: did, ip })).body).toEqual({ counted: true });
      const day1 = today();
      t.clock.advance(24 * 3600_000);
      try {
        expect((await view(r.id, { watchedSec: 10 }, { cookie: did, ip })).body).toEqual({ counted: true });
        await flusher.flush();
        expect((await daily(r.id)).map((d) => [d.day, d.views, d.watchSec])).toEqual([
          [day1, 1, 10],
          [today(), 1, 10],
        ]);
      } finally {
        t.clock.advance(-24 * 3600_000);
      }
    });
  });

  describe("view inflation", () => {
    it("rotating the anonymous id counts each new id, up to 300 an hour per address; after that nothing counts", async () => {
      const r = await reel((await t.login()).userId);
      const ip = uniqueIp();
      let counted = 0;
      for (let i = 0; i < 305; i++) if ((await view(r.id, { watchedSec: 4 }, { cookie: deviceId(), ip })).body.counted) counted++;
      expect(counted).toBe(300);
      // Another address is unaffected; so is a signed-in viewer on the capped one.
      expect((await view(r.id, { watchedSec: 4 }, { cookie: deviceId() })).body).toEqual({ counted: true });
      expect((await view(r.id, { watchedSec: 4 }, { ip, token: (await t.login()).accessToken })).body).toEqual({ counted: true });
      await flusher.flush();
      expect((await row(r.id)).viewCount).toBe(302);
    }, 120_000);
  });

  describe("flushing to Postgres", () => {
    it("adds the counts to the reel and the day, with an approximate unique-viewer count; a second flush finds nothing", async () => {
      const r = await reel((await t.login()).userId);
      for (let i = 0; i < 3; i++) await view(r.id, { watchedSec: 10 }, { cookie: deviceId() });
      expect(await redis.hlen(PENDING)).toBeGreaterThan(0);
      await flusher.flush();
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 3, watchSecTotal: 30 });
      const [d] = await daily(r.id);
      expect(d).toMatchObject({ day: today(), views: 3, watchSec: 30, uniqueViewers: 3 });
      await view(r.id, { watchedSec: 10 }, { cookie: deviceId() });
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 4, watchSecTotal: 40 });
      expect(await daily(r.id)).toMatchObject([{ views: 4, watchSec: 40, uniqueViewers: 4 }]);
    });

    it("views that arrive while a flush runs are kept for the next one", async () => {
      const r = await reel((await t.login()).userId);
      await view(r.id, { watchedSec: 10 }, { cookie: deviceId() });
      const first = flusher.flush();
      await view(r.id, { watchedSec: 10 }, { cookie: deviceId() });
      await first;
      await flusher.flush();
      expect((await row(r.id)).viewCount).toBe(2);
    });

    it("a crashed flush is applied exactly once by the recovery step, and only when it is stale (5 minutes)", async () => {
      const r = await reel((await t.login()).userId);
      const stale = `reelviews:flushing:${t.clock.now().getTime() - 6 * 60_000}-${randomUUID()}`;
      const fresh = `reelviews:flushing:${t.clock.now().getTime() - 60_000}-${randomUUID()}`;
      await redis.hset(stale, `${r.id}:${today()}:v`, 7, `${r.id}:${today()}:w`, 70);
      await redis.hset(fresh, `${r.id}:${today()}:v`, 100, `${r.id}:${today()}:w`, 1000);
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 7, watchSecTotal: 70 });
      expect(await redis.exists(stale)).toBe(0);
      expect(await redis.exists(fresh)).toBe(1); // might still be being applied by a live run
      await redis.del(fresh);
    });

    it("applying a batch twice (the key survived the crash after the commit) changes nothing", async () => {
      const r = await reel((await t.login()).userId);
      const key = `reelviews:flushing:${t.clock.now().getTime() - 10 * 60_000}-${randomUUID()}`;
      const fields: [string, number][] = [[`${r.id}:${today()}:v`, 5], [`${r.id}:${today()}:w`, 50]];
      for (const [f, v] of fields) await redis.hset(key, f, v);
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 5, watchSecTotal: 50 });
      for (const [f, v] of fields) await redis.hset(key, f, v); // the same batch is still there
      await flusher.flush();
      await flusher.flush();
      expect(await row(r.id)).toMatchObject({ viewCount: 5, watchSecTotal: 50 });
      expect(await redis.exists(key)).toBe(0);
      expect(await prisma.reelViewFlush.count({ where: { id: key.slice("reelviews:flushing:".length) } })).toBe(1);
      expect(await daily(r.id)).toMatchObject([{ views: 5, watchSec: 50 }]);
    });

    it("a failed apply leaves the batch in Redis for the next run (nothing lost, nothing counted twice)", async () => {
      const r = await reel((await t.login()).userId);
      await view(r.id, { watchedSec: 10 }, { cookie: deviceId() });
      const spy = jest.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("db down"));
      await expect(flusher.flush()).rejects.toThrow("db down");
      spy.mockRestore();
      const leftover = await redis.keys("reelviews:flushing:*");
      expect(leftover.length).toBeGreaterThan(0);
      expect((await row(r.id)).viewCount).toBe(0);
      t.clock.advance(6 * 60_000);
      try {
        await flusher.flush();
      } finally {
        t.clock.advance(-6 * 60_000);
      }
      expect(await row(r.id)).toMatchObject({ viewCount: 1, watchSecTotal: 10 });
      expect(await redis.keys("reelviews:flushing:*")).toEqual([]);
    });

    it("counts for a reel that no longer exists are dropped, not retried for ever", async () => {
      const key = `reelviews:flushing:${t.clock.now().getTime() - 10 * 60_000}-${randomUUID()}`;
      await redis.hset(key, `${randomUUID()}:${today()}:v`, 2);
      await flusher.flush();
      expect(await redis.exists(key)).toBe(0);
    });
  });
});
