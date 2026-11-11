import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { APP_CONFIG } from "../../src/common/config/config.module";
import type { AppConfig } from "../../src/common/config/config.schema";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { ANON_LESSON_READS_PER_MINUTE } from "../../src/modules/courses/learn.controller";
import { ANON_PLAYBACKS_PER_HOUR } from "../../src/modules/media/media.controller";
import { verifyPlaybackToken } from "../../src/modules/media/playback-token";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("signed-out visitors and free-preview lessons", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const lessonUrl = (id: string) => `/v1/learn/lessons/${id}`;
  const playUrl = (id: string) => `/v1/media/${id}/playback`;
  /** A signed-out caller: no token, its own address. */
  const anon = () => ({ "X-Forwarded-For": uniqueIp() });

  async function asset(ownerId: string, purpose: "COURSE_LESSON" | "COURSE_RESOURCE" = "COURSE_LESSON") {
    const id = uuidv7();
    return prisma.mediaAsset.create({
      data: {
        id,
        ownerId,
        purpose,
        bucket: "PRIVATE",
        status: "READY",
        attachedAt: new Date(),
        objectKey: purpose === "COURSE_LESSON" ? `incoming/${id}/source` : `course_resource/${ownerId}/${id}/source`,
        filename: purpose === "COURSE_RESOURCE" ? "notes.pdf" : null,
        mime: purpose === "COURSE_LESSON" ? "video/mp4" : "application/pdf",
        declaredSize: 1000n,
        durationSec: purpose === "COURSE_LESSON" ? 600 : null,
      },
    });
  }

  async function course(owner: Session, over: { status?: "PUBLISHED" | "IN_REVIEW" | "DRAFT"; flagged?: boolean } = {}) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Preview ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "49900" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string; slug: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    const paidVideo = await asset(owner.userId);
    const previewVideo = await asset(owner.userId);
    const resource = await asset(owner.userId, "COURSE_RESOURCE");
    const previewFile = await asset(owner.userId, "COURSE_RESOURCE");
    const mk = (position: number, data: Record<string, unknown>) => prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: `L${position}`, position, ...(data as object) } as never });
    const lessons = {
      video: await mk(0, { type: "VIDEO", videoAssetId: paidVideo.id, durationSec: 600 }),
      preview: await mk(1, { type: "VIDEO", videoAssetId: previewVideo.id, durationSec: 600, isFreePreview: true }),
      article: await mk(2, { type: "ARTICLE", articleBody: "paid words" }),
      previewArticle: await mk(3, { type: "ARTICLE", articleBody: "free words", isFreePreview: true }),
      resource: await mk(4, { type: "RESOURCE", resourceAssetId: resource.id }),
      previewResource: await mk(5, { type: "RESOURCE", resourceAssetId: previewFile.id, isFreePreview: true }),
    };
    await prisma.course.update({
      where: { id: c.id },
      data: { status: over.status ?? "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date(), ...(over.flagged ? { flaggedAt: new Date(), flagReason: "spam" } : {}) },
    });
    return { ...c, lessons, paidAsset: paidVideo.id, previewAsset: previewVideo.id, resourceAsset: resource.id };
  }

  async function owner() {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("GET /v1/learn/lessons/:id", () => {
    it("a signed-out visitor opens a free-preview lesson of a published course", async () => {
      const c = await course(await owner());
      const article = await http().get(lessonUrl(c.lessons.previewArticle.id)).set(anon());
      expect(article.status).toBe(200);
      expect(article.body).toMatchObject({ articleBody: "free words", access: "PREVIEW", canTrackProgress: false, progress: { positionSec: 0, completed: false } });
      const video = await http().get(lessonUrl(c.lessons.preview.id)).set(anon());
      expect(video.status).toBe(200);
      expect(video.body.videoAssetId).toBe(c.previewAsset);
    });

    it("a free-preview resource lesson carries its short download link; a paid one does not open", async () => {
      const c = await course(await owner());
      const open = await http().get(lessonUrl(c.lessons.previewResource.id)).set(anon());
      expect(open.status).toBe(200);
      expect(open.body.resource.url).toContain("X-Amz-Expires=300");
      expect((await http().get(lessonUrl(c.lessons.resource.id)).set(anon())).status).toBe(403);
    });

    it("a signed-out visitor gets what a non-enrolled user gets for a lesson that is not a preview", async () => {
      const c = await course(await owner());
      const stranger = await t.login();
      for (const lesson of [c.lessons.video, c.lessons.article]) {
        const signedOut = await http().get(lessonUrl(lesson.id)).set(anon());
        const signedIn = await http().get(lessonUrl(lesson.id)).set(auth(stranger));
        expect(signedOut.status).toBe(403);
        expect(signedOut.body.error.code).toBe("COURSE_NOT_ENROLLED");
        expect(signedOut.status).toBe(signedIn.status);
        expect(signedOut.body.error).toEqual(signedIn.body.error);
      }
    });

    it("a preview lesson of a flagged, in-review or draft course is as closed to a signed-out visitor as to a non-enrolled user", async () => {
      const o = await owner();
      const stranger = await t.login();
      for (const over of [{ flagged: true }, { status: "IN_REVIEW" as const }, { status: "DRAFT" as const }]) {
        const c = await course(o, over);
        const signedOut = await http().get(lessonUrl(c.lessons.previewArticle.id)).set(anon());
        const signedIn = await http().get(lessonUrl(c.lessons.previewArticle.id)).set(auth(stranger));
        expect(signedOut.status).toBeGreaterThanOrEqual(400);
        expect(signedOut.status).toBe(signedIn.status);
        expect(signedOut.body.error).toEqual(signedIn.body.error);
        expect(JSON.stringify(signedOut.body)).not.toContain("free words");
      }
    });

    it("an unknown lesson is 404 for a signed-out visitor too", async () => {
      expect((await http().get(lessonUrl(uuidv7())).set(anon())).status).toBe(404);
    });

    it("a token that is sent must still be good: a bad one is 401, never a silent downgrade to signed-out", async () => {
      const c = await course(await owner());
      const bad = await http().get(lessonUrl(c.lessons.previewArticle.id)).set({ ...anon(), Authorization: "Bearer nonsense" });
      expect(bad.status).toBe(401);
      const noScheme = await http().get(lessonUrl(c.lessons.previewArticle.id)).set({ ...anon(), Authorization: "Basic abc" });
      expect(noScheme.status).toBe(401);
    });

    it("signed-in behaviour is unchanged: a stranger gets preview access without progress, the author is AUTHOR", async () => {
      const o = await owner();
      const c = await course(o);
      const learner = await t.login();
      await http().get(lessonUrl(c.lessons.article.id)).set(auth(learner)).expect(403);
      expect((await http().get(lessonUrl(c.lessons.previewArticle.id)).set(auth(learner))).body).toMatchObject({ access: "PREVIEW", canTrackProgress: false });
      expect((await http().get(lessonUrl(c.lessons.article.id)).set(auth(o))).body.access).toBe("AUTHOR");
    });

    it("progress writes stay signed-in only", async () => {
      const c = await course(await owner());
      expect((await http().put(`${lessonUrl(c.lessons.preview.id)}/progress`).set(anon()).send({ positionSec: 5 })).status).toBe(401);
      expect((await http().post(`${lessonUrl(c.lessons.previewArticle.id)}/complete`).set(anon())).status).toBe(401);
    });

    it("signed-out reads are limited per address, signed-in ones are not", async () => {
      const ip = uniqueIp();
      const missing = uuidv7();
      for (let i = 0; i < ANON_LESSON_READS_PER_MINUTE; i++) expect((await http().get(lessonUrl(missing)).set("X-Forwarded-For", ip)).status).toBe(404);
      expect((await http().get(lessonUrl(missing)).set("X-Forwarded-For", ip)).status).toBe(429);
      // another address is unaffected, and so is a signed-in caller from the exhausted one
      expect((await http().get(lessonUrl(missing)).set(anon())).status).toBe(404);
      const s = await t.login();
      expect((await http().get(lessonUrl(missing)).set(auth(s)).set("X-Forwarded-For", ip)).status).toBe(404);
    });
  });

  describe("GET /v1/media/:id/playback", () => {
    it("a signed-out visitor gets a token for a preview video; it names no user", async () => {
      const c = await course(await owner());
      const res = await http().get(playUrl(c.previewAsset)).set(anon());
      expect(res.status).toBe(200);
      const url = new URL(res.body.manifestUrl);
      expect(url.pathname).toContain(`/${c.previewAsset}/hls/index.m3u8`);
      const secret = t.app.get<AppConfig>(APP_CONFIG).playbackSecret;
      const claims = verifyPlaybackToken(url.searchParams.get("t") ?? "", secret, Math.floor(t.clock.now().getTime() / 1000));
      expect(claims).not.toBeNull();
      expect(claims?.a).toBe(c.previewAsset);
      expect(claims?.u).toBe("anonymous");
      expect(res.body.expiresAt).toBeTruthy();
      expect(JSON.stringify(res.body.watermark)).not.toMatch(/@/); // no email, no id
    });

    it("a signed-out visitor is refused the video of a paid lesson with the same 403 a non-enrolled user gets", async () => {
      const c = await course(await owner());
      const stranger = await t.login();
      const signedOut = await http().get(playUrl(c.paidAsset)).set(anon());
      const signedIn = await http().get(playUrl(c.paidAsset)).set(auth(stranger));
      expect(signedOut.status).toBe(403);
      expect(signedOut.body.error).toEqual(signedIn.body.error);
    });

    it("preview videos of a flagged, in-review or draft course are refused to a signed-out visitor", async () => {
      const o = await owner();
      for (const over of [{ flagged: true }, { status: "IN_REVIEW" as const }, { status: "DRAFT" as const }]) {
        const c = await course(o, over);
        expect((await http().get(playUrl(c.previewAsset)).set(anon())).status).toBe(403);
      }
    });

    it("an unknown asset is 404, a resource file is refused, and a bad token is 401", async () => {
      const c = await course(await owner());
      expect((await http().get(playUrl(uuidv7())).set(anon())).status).toBe(404);
      expect((await http().get(playUrl(c.resourceAsset)).set(anon())).status).toBe(403);
      expect((await http().get(playUrl(c.previewAsset)).set({ ...anon(), Authorization: "Bearer nonsense" })).status).toBe(401);
    });

    it("signed-in behaviour is unchanged: the token and watermark name the user, a paid video is 403 until enrolled", async () => {
      const c = await course(await owner());
      const learner = await t.login();
      const preview = await http().get(playUrl(c.previewAsset)).set(auth(learner));
      expect(preview.status).toBe(200);
      expect(preview.body.watermark).toBe(learner.email);
      const token = new URL(preview.body.manifestUrl).searchParams.get("t") as string;
      expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).u).toBe(learner.userId);
      expect((await http().get(playUrl(c.paidAsset)).set(auth(learner))).status).toBe(403);
    });

    it("signed-out playback is limited per address, signed-in playback keeps its own per-user limit", async () => {
      const c = await course(await owner());
      const ip = uniqueIp();
      for (let i = 0; i < ANON_PLAYBACKS_PER_HOUR; i++) expect((await http().get(playUrl(c.previewAsset)).set("X-Forwarded-For", ip)).status).toBe(200);
      expect((await http().get(playUrl(c.previewAsset)).set("X-Forwarded-For", ip)).status).toBe(429);
      expect((await http().get(playUrl(c.previewAsset)).set(anon())).status).toBe(200);
      const s = await t.login();
      expect((await http().get(playUrl(c.previewAsset)).set(auth(s)).set("X-Forwarded-For", ip)).status).toBe(200);
    });
  });
});
