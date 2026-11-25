import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { APP_CONFIG } from "../../src/common/config/config.module";
import type { AppConfig } from "../../src/common/config/config.schema";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PlaybackPolicies } from "../../src/modules/media/playback-policy";
import { verifyPlaybackToken } from "../../src/modules/media/playback-token";
import { RolesService } from "../../src/modules/rbac/roles.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("signed private playback", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let config: AppConfig;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const playback = (s: Session, id: string) => http().get(`/v1/media/${id}/playback`).set(auth(s));

  async function lesson(owner: Session, overrides: Record<string, unknown> = {}) {
    const id = uuidv7();
    return prisma.mediaAsset.create({
      data: {
        id,
        ownerId: owner.userId,
        purpose: "COURSE_LESSON",
        bucket: "PRIVATE",
        status: "READY",
        objectKey: `incoming/${id}/source`,
        mime: "video/mp4",
        declaredSize: BigInt(1000),
        ...overrides,
      },
    });
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    config = t.app.get<AppConfig>(APP_CONFIG);
  });
  afterAll(() => t?.close());

  // The route is optional-auth since signed-out visitors may play free-preview videos (test/e2e/course-preview-anonymous.e2e-spec.ts):
  // no token is a visitor (an unknown asset is 404, a private one 404 too), but a token that is sent must still be good.
  it("treats a missing token as a visitor who can play nothing private, and still rejects a bad token", async () => {
    expect((await http().get(`/v1/media/${uuidv7()}/playback`)).status).toBe(404);
    expect((await http().get(`/v1/media/${uuidv7()}/playback`).set({ Authorization: "Bearer nonsense" })).status).toBe(401);
  });

  it("refuses a visitor the private lesson video of a user", async () => {
    const owner = await t.login();
    const asset = await lesson(owner);
    expect((await http().get(`/v1/media/${asset.id}/playback`)).status).toBe(404);
  });

  it("gives the owner a manifest URL with a 10-minute token for exactly that asset, plus the email watermark", async () => {
    const owner = await t.login();
    const asset = await lesson(owner);
    const res = await playback(owner, asset.id);
    expect(res.status).toBe(200);

    const url = new URL(res.body.manifestUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${config.r2.playbackBaseUrl}/course_lesson/${owner.userId}/${asset.id}/hls/index.m3u8`);
    const nowSec = Math.floor(t.clock.now().getTime() / 1000);
    const claims = verifyPlaybackToken(url.searchParams.get("t")!, config.playbackSecret, nowSec);
    expect(claims).toEqual({ u: owner.userId, a: asset.id, exp: nowSec + 600 });
    expect(res.body.expiresAt).toBe(new Date((nowSec + 600) * 1000).toISOString());
    expect(res.body.watermark).toBe(owner.email);
    expect(Object.keys(res.body).sort()).toEqual(["expiresAt", "manifestUrl", "watermark"]);
  });

  it("the token stops verifying after 10 minutes", async () => {
    const owner = await t.login();
    const asset = await lesson(owner);
    const res = await playback(owner, asset.id);
    const token = new URL(res.body.manifestUrl).searchParams.get("t")!;
    const exp = Math.floor(t.clock.now().getTime() / 1000) + 600;
    expect(verifyPlaybackToken(token, config.playbackSecret, exp - 1)).not.toBeNull();
    expect(verifyPlaybackToken(token, config.playbackSecret, exp)).toBeNull();
  });

  it("denies a stranger with the same 404 MEDIA_NOT_FOUND as a missing asset and allows media.manage_any", async () => {
    const owner = await t.login();
    const stranger = await t.login();
    const moderator = await t.login();
    const asset = await lesson(owner);

    const denied = await playback(stranger, asset.id);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("MEDIA_NOT_FOUND");

    await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
    expect((await playback(moderator, asset.id)).status).toBe(200);
  });

  it("any registered policy returning true allows (Phase 3 enrolment hook)", async () => {
    const owner = await t.login();
    const learner = await t.login();
    const asset = await lesson(owner);
    expect((await playback(learner, asset.id)).status).toBe(404);

    t.app.get(PlaybackPolicies).register({ canPlay: async (userId, a) => userId === learner.userId && a.id === asset.id });
    expect((await playback(learner, asset.id)).status).toBe(200);
    const other = await lesson(owner);
    expect((await playback(learner, other.id)).status).toBe(404);
  });

  it("a lesson that is not READY is MEDIA_NOT_READY", async () => {
    const owner = await t.login();
    for (const status of ["PENDING", "PROCESSING", "FAILED"] as const) {
      const asset = await lesson(owner, { status });
      const res = await playback(owner, asset.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("MEDIA_NOT_READY");
    }
  });

  it("only private lesson videos: public reels and resources are MEDIA_NOT_PLAYABLE; unknown ids are 404", async () => {
    const owner = await t.login();
    const reel = await lesson(owner, { purpose: "REEL", bucket: "PUBLIC" });
    const pdf = await lesson(owner, { purpose: "COURSE_RESOURCE", mime: "application/pdf" });
    for (const a of [reel, pdf]) {
      const res = await playback(owner, a.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("MEDIA_NOT_PLAYABLE");
    }
    const publicLesson = await lesson(owner, { bucket: "PUBLIC" });
    const res2 = await playback(owner, publicLesson.id);
    expect(res2.status).toBe(422);
    expect(res2.body.error.code).toBe("MEDIA_NOT_PLAYABLE");
    expect((await playback(owner, uuidv7())).status).toBe(404);
    expect((await playback(owner, "not-a-uuid")).status).toBe(400);
  });

  it("is rate limited to 120 per hour per user", async () => {
    const owner = await t.login();
    const asset = await lesson(owner);
    for (let i = 0; i < 120; i++) expect((await playback(owner, asset.id)).status).toBe(200);
    const res = await playback(owner, asset.id);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    // other users are unaffected
    const other = await t.login();
    expect((await playback(other, (await lesson(other)).id)).status).toBe(200);
  });
});
