import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { assetPrefix } from "../../src/modules/media/media.rules";
import { R2Client } from "../../src/modules/media/r2.client";
import { RolesService } from "../../src/modules/rbac";
import { givePlan } from "../support/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const DAY = 24 * 3600_000;

describe("phase 4 final fixes: delete vs strike, ban on edits, takedown", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let r2: R2Client;
  let moderator: Session;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function creator() {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    await givePlan(prisma, "USER", s.userId, "business");
    return s;
  }
  async function postReel(owner: Session, caption = `final #tag${uniq()}`) {
    const a = await prisma.mediaAsset.create({ data: { ownerId: owner.userId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 } });
    const res = await http().post("/v1/reels").set(auth(owner)).send({ mediaAssetId: a.id, caption });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, asset: a };
  }
  const report = (s: Session, targetType: string, targetId: string) => http().post("/v1/reports").set(auth(s)).send({ targetType, targetId, reason: "SPAM" });
  const uphold = (type: string, id: string) => http().post(`/v1/admin/moderation/targets/${type}/${id}/uphold`).set(auth(moderator)).send({ note: "no" });
  const dismiss = (type: string, id: string) => http().post(`/v1/admin/moderation/targets/${type}/${id}/dismiss`).set(auth(moderator)).send({ note: "fine" });
  const reelRow = (id: string) => prisma.reel.findUniqueOrThrow({ where: { id } });
  const assetRow = (id: string) => prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
  const ban = (userId: string) => prisma.userRestriction.create({ data: { userId, until: new Date(t.clock.now().getTime() + 7 * DAY), reason: "test" } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    r2 = t.app.get(R2Client);
    moderator = await t.login();
    await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  describe("C1: deleting reported content does not escape the strike", () => {
    it("report, creator deletes, moderator upholds: the strike is recorded, the reel stays deleted, the video is purged", async () => {
      const owner = await creator();
      const { id, asset } = await postReel(owner);
      const prefix = `${assetPrefix(asset)}/`;
      await r2.putObject("PUBLIC", `${prefix}master.m3u8`, "#EXTM3U", "application/vnd.apple.mpegurl");
      expect((await report(await t.login(), "REEL", id)).status).toBe(201);

      expect((await http().delete(`/v1/reels/${id}`).set(auth(owner))).status).toBe(204);
      // The evidence stays attached while reports are open.
      expect((await assetRow(asset.id)).attachedAt).not.toBeNull();
      expect(await r2.listKeys("PUBLIC", prefix)).toHaveLength(1);
      // A deleted reel cannot be reported any more.
      expect((await report(await t.login(), "REEL", id)).status).toBe(404);

      const res = await uphold("REEL", id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ decision: "UPHELD", reports: 1 });
      expect(await prisma.strike.count({ where: { userId: owner.userId } })).toBe(1);
      expect((await reelRow(id)).status).toBe("DELETED");
      expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
      expect(await r2.listKeys("PUBLIC", prefix)).toEqual([]);
    });

    it("an auto-hidden reel that is deleted can still be upheld", async () => {
      const owner = await creator();
      const { id } = await postReel(owner);
      for (const u of await Promise.all(Array.from({ length: 5 }, () => t.login()))) await report(u, "REEL", id);
      expect((await reelRow(id)).status).toBe("HIDDEN");
      expect((await http().delete(`/v1/reels/${id}`).set(auth(owner))).status).toBe(204);
      expect((await uphold("REEL", id)).status).toBe(200);
      expect(await prisma.strike.count({ where: { userId: owner.userId } })).toBe(1);
      expect((await reelRow(id)).status).toBe("DELETED");
    });

    it("dismissing the reports of a deleted reel releases its video for the normal cleanup, with no strike", async () => {
      const owner = await creator();
      const { id, asset } = await postReel(owner);
      await report(await t.login(), "REEL", id);
      await http().delete(`/v1/reels/${id}`).set(auth(owner)).expect(204);
      expect((await assetRow(asset.id)).attachedAt).not.toBeNull();
      expect((await dismiss("REEL", id)).status).toBe(200);
      const after = await assetRow(asset.id);
      expect([after.attachedAt, after.detachedAt === null]).toEqual([null, false]);
      expect(await prisma.strike.count({ where: { userId: owner.userId } })).toBe(0);
    });

    it("deleting a reel nobody reported releases its video at once, as before", async () => {
      const owner = await creator();
      const { id, asset } = await postReel(owner);
      await http().delete(`/v1/reels/${id}`).set(auth(owner)).expect(204);
      expect((await assetRow(asset.id)).attachedAt).toBeNull();
    });

    it("a comment deleted after it was reported can still be upheld: strike for its author", async () => {
      const owner = await creator();
      const { id } = await postReel(owner);
      const author = await t.login();
      const c = await http().post(`/v1/reels/${id}/comments`).set(auth(author)).send({ body: "rude" });
      expect(c.status).toBe(201);
      expect((await report(await t.login(), "REEL_COMMENT", c.body.id)).status).toBe(201);
      await http().delete(`/v1/reels/${id}/comments/${c.body.id}`).set(auth(author)).expect(204);
      expect((await uphold("REEL_COMMENT", c.body.id)).status).toBe(200);
      expect(await prisma.strike.count({ where: { userId: author.userId } })).toBe(1);
      expect((await prisma.reelComment.findUniqueOrThrow({ where: { id: c.body.id } })).status).toBe("DELETED");
      // Truly absent content is still gone.
      expect((await uphold("REEL", randomUUID())).body.error.code).toBe("TARGET_GONE");
    });
  });

  describe("I1: a posting ban covers edits", () => {
    it("blocks caption and link edits of a reel and comment edits; other edits still work", async () => {
      const owner = await creator();
      const { id } = await postReel(owner);
      const c = await http().post(`/v1/reels/${id}/comments`).set(auth(owner)).send({ body: "mine" });
      expect(c.status).toBe(201);
      await ban(owner.userId);

      const caption = await http().patch(`/v1/reels/${id}`).set(auth(owner)).send({ caption: "new text #fresh" });
      expect([caption.status, caption.body.error.code]).toEqual([403, "POSTING_RESTRICTED"]);
      const link = await http().patch(`/v1/reels/${id}`).set(auth(owner)).send({ linkedCourseId: null });
      expect([link.status, link.body.error.code]).toEqual([403, "POSTING_RESTRICTED"]);
      const edit = await http().patch(`/v1/reels/${id}/comments/${c.body.id}`).set(auth(owner)).send({ body: "edited" });
      expect([edit.status, edit.body.error.code]).toEqual([403, "POSTING_RESTRICTED"]);
      expect((await prisma.reelComment.findUniqueOrThrow({ where: { id: c.body.id } })).body).toBe("mine");
      expect((await http().patch(`/v1/reels/${id}`).set(auth(owner)).send({ commentsEnabled: false })).status).toBe(200);
    });
  });

  describe("I2: an upheld removal takes the video down at once", () => {
    it("deletes the HLS objects and poster right after the decision; the reel row stays REMOVED", async () => {
      const owner = await creator();
      const { id, asset } = await postReel(owner);
      const prefix = `${assetPrefix(asset)}/`;
      for (const k of ["master.m3u8", "720p/seg0.ts", "poster.jpg"]) await r2.putObject("PUBLIC", `${prefix}${k}`, "x", "application/octet-stream");
      expect(await r2.listKeys("PUBLIC", prefix)).toHaveLength(3);
      await report(await t.login(), "REEL", id);

      expect((await uphold("REEL", id)).status).toBe(200);
      expect(await r2.listKeys("PUBLIC", prefix)).toEqual([]);
      expect(await r2.head("PUBLIC", `${prefix}master.m3u8`)).toBeNull();
      expect((await reelRow(id)).status).toBe("REMOVED");
      expect(await prisma.mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
    });
  });
});
