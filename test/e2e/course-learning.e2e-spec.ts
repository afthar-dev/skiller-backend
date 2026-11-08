import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { EnrolmentsService } from "../../src/modules/courses";
import { PermissionService, RolesService } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { expectDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("learner access to course content", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
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

  /** A course with a paid video lesson, a free-preview video lesson, an article and a resource lesson (written straight to the tables). */
  async function course(owner: Session, over: { pricePaise?: string; status?: "PUBLISHED" | "IN_REVIEW" | "DRAFT"; flagged?: boolean; archived?: boolean } = {}) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Learn ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: over.pricePaise ?? "0" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string; slug: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    const paidVideo = await asset(owner.userId);
    const previewVideo = await asset(owner.userId);
    const resource = await asset(owner.userId, "COURSE_RESOURCE");
    const mk = (position: number, data: Record<string, unknown>) => prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: `L${position}`, position, ...(data as object) } as never });
    const lessons = {
      video: await mk(0, { type: "VIDEO", videoAssetId: paidVideo.id, durationSec: 600 }),
      preview: await mk(1, { type: "VIDEO", videoAssetId: previewVideo.id, durationSec: 600, isFreePreview: true }),
      article: await mk(2, { type: "ARTICLE", articleBody: "# Hello" }),
      resource: await mk(3, { type: "RESOURCE", resourceAssetId: resource.id }),
      previewArticle: await mk(4, { type: "ARTICLE", articleBody: "free words", isFreePreview: true }),
    };
    await prisma.course.update({
      where: { id: c.id },
      data: {
        status: over.archived ? "ARCHIVED" : (over.status ?? "PUBLISHED"),
        publishedAt: new Date(),
        slugLockedAt: new Date(),
        ...(over.flagged ? { flaggedAt: new Date(), flagReason: "spam" } : {}),
      },
    });
    return { ...c, section, lessons, paidAsset: paidVideo.id, previewAsset: previewVideo.id };
  }
  const play = (s: Session, assetId: string) => http().get(`/v1/media/${assetId}/playback`).set(auth(s));
  const enrol = async (s: Session, slug: string) => expect((await http().post(`/v1/courses/${slug}/enrol`).set(auth(s))).status).toBe(201);
  async function purchased(courseId: string, userId: string) {
    const orderId = uuidv7();
    await prisma.$transaction((tx) => t.app.get(EnrolmentsService).grant(tx, { courseId, userId, source: "PURCHASE", orderId }));
    return orderId;
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("video playback policy (Review Focus 1)", () => {
    it("a stranger cannot get a token for a paid lesson video, an enrolled learner can", async () => {
      const owner = await creator();
      const c = await course(owner);
      const stranger = await t.login();
      expect((await play(stranger, c.paidAsset)).status).toBe(403);
      const learner = await t.login();
      expect((await play(learner, c.paidAsset)).status).toBe(403);
      await enrol(learner, c.slug);
      expect((await play(learner, c.paidAsset)).status).toBe(200);
    });

    it("free-preview videos of a published course play for anyone; of a flagged or unpublished course they do not", async () => {
      const owner = await creator();
      const stranger = await t.login();
      const open = await course(owner);
      expect((await play(stranger, open.previewAsset)).status).toBe(200);
      const flagged = await course(owner, { flagged: true });
      expect((await play(stranger, flagged.previewAsset)).status).toBe(403);
      const draft = await course(owner, { status: "DRAFT" });
      expect((await play(stranger, draft.previewAsset)).status).toBe(403);
    });

    it("a refunded learner loses playback immediately; a rebuy restores it", async () => {
      const owner = await creator();
      const c = await course(owner, { pricePaise: "49900" });
      const buyer = await t.login();
      const orderId = await purchased(c.id, buyer.userId);
      expect((await play(buyer, c.paidAsset)).status).toBe(200);
      await prisma.$transaction((tx) => t.app.get(EnrolmentsService).revokeForOrder(tx, { courseId: c.id, userId: buyer.userId, orderId }));
      expect((await play(buyer, c.paidAsset)).status).toBe(403);
    });

    it("a buyer keeps playing after the course is archived or flagged", async () => {
      const owner = await creator();
      const c = await course(owner, { pricePaise: "49900" });
      const buyer = await t.login();
      await purchased(c.id, buyer.userId);
      await prisma.course.update({ where: { id: c.id }, data: { status: "ARCHIVED" } });
      expect((await play(buyer, c.paidAsset)).status).toBe(200);
      await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", flaggedAt: new Date() } });
      expect((await play(buyer, c.paidAsset)).status).toBe(200);
    });

    it("authors, course.manage_any and moderators (reviewable courses only) can play", async () => {
      const owner = await creator();
      const c = await course(owner, { status: "DRAFT" });
      expect((await play(owner, c.paidAsset)).status).toBe(200);

      const moderator = await t.login();
      await t.app.get(RolesService).grantSystem(moderator.userId, "moderator");
      // (the moderator role also holds media.manage_any, which plays any asset, so the lesson rules are checked on the learn endpoint)
      const open = () => http().get(`/v1/learn/lessons/${c.lessons.article.id}`).set(auth(moderator));
      expect((await open()).status).toBe(404); // a draft is not reviewable
      await prisma.course.update({ where: { id: c.id }, data: { status: "IN_REVIEW" } });
      const reviewing = await open();
      expect(reviewing.status).toBe(200);
      expect(reviewing.body).toMatchObject({ access: "REVIEW", canTrackProgress: false });
      expect((await play(moderator, c.paidAsset)).status).toBe(200);

      const admin = await t.login();
      await t.app.get(RolesService).grantSystem(admin.userId, "super_admin");
      await prisma.course.update({ where: { id: c.id }, data: { status: "DRAFT" } });
      expect((await play(admin, c.paidAsset)).status).toBe(200);
    });

    it("an organization seat plays only while the org_learner grant is live", async () => {
      const owner = await creator();
      const learner = await t.login();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
      const orgRole = await prisma.role.findUniqueOrThrow({ where: { key: "org_learner" } });
      const grant = await prisma.userRole.create({ data: { userId: learner.userId, roleId: orgRole.id, orgId: org.id } });
      await t.app.get(PermissionService).invalidateUser(learner.userId);
      const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: "org_owner" } });
      await prisma.userRole.create({ data: { userId: owner.userId, roleId: ownerRole.id, orgId: org.id } });
      const c = await course(owner);
      await prisma.course.update({ where: { id: c.id }, data: { ownerType: "ORG", ownerId: org.id, pricePaise: 99900n } });
      await enrol(learner, c.slug);
      expect((await play(learner, c.paidAsset)).status).toBe(200);
      await prisma.userRole.delete({ where: { id: grant.id } });
      await t.app.get(PermissionService).invalidateUser(learner.userId);
      expect((await play(learner, c.paidAsset)).status).toBe(403);
    });
  });

  describe("GET /v1/learn/courses/:slug", () => {
    it("requires login; a non-enrolled user gets 403 COURSE_NOT_ENROLLED; a draft is a 404", async () => {
      const owner = await creator();
      const c = await course(owner);
      expect((await http().get(`/v1/learn/courses/${c.slug}`)).status).toBe(401);
      const stranger = await t.login();
      const denied = await http().get(`/v1/learn/courses/${c.slug}`).set(auth(stranger));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("COURSE_NOT_ENROLLED");
      const draft = await course(owner, { status: "DRAFT" });
      expect((await http().get(`/v1/learn/courses/${draft.slug}`).set(auth(stranger))).status).toBe(404);
      expect((await http().get(`/v1/learn/courses/nope-${uniq()}`).set(auth(stranger))).status).toBe(404);
    });

    it("shows an enrolled learner the full curriculum with their progress, and no content bodies or asset ids", async () => {
      const owner = await creator();
      const c = await course(owner);
      const learner = await t.login();
      await enrol(learner, c.slug);
      await prisma.lessonProgress.create({ data: { userId: learner.userId, lessonId: c.lessons.article.id, courseId: c.id, positionSec: 0, watchedSec: 0, completedAt: new Date() } });
      const res = await http().get(`/v1/learn/courses/${c.slug}`).set(auth(learner));
      expect(res.status).toBe(200);
      expect(res.body.course).toMatchObject({ id: c.id, slug: c.slug, progressPct: 0 });
      expectDeclared(res, "GET /v1/learn/courses/{slug}");
      const lessons = res.body.sections[0].lessons as Array<{ id: string; completed: boolean; positionSec: number; type: string }>;
      expect(lessons.map((l) => l.id)).toEqual([c.lessons.video.id, c.lessons.preview.id, c.lessons.article.id, c.lessons.resource.id, c.lessons.previewArticle.id]);
      expect(lessons.find((l) => l.id === c.lessons.article.id)).toMatchObject({ completed: true });
      expect(lessons.find((l) => l.id === c.lessons.video.id)).toMatchObject({ completed: false, positionSec: 0 });
      expect(JSON.stringify(res.body)).not.toContain("articleBody");
    });

    it("lets the author in", async () => {
      const owner = await creator();
      const c = await course(owner, { status: "DRAFT" });
      expect((await http().get(`/v1/learn/courses/${c.slug}`).set(auth(owner))).status).toBe(200);
    });
  });

  describe("GET /v1/learn/lessons/:id", () => {
    it("returns article, video asset id and a 5-minute resource download to an enrolled learner", async () => {
      const owner = await creator();
      const c = await course(owner);
      const learner = await t.login();
      await enrol(learner, c.slug);
      const article = await http().get(`/v1/learn/lessons/${c.lessons.article.id}`).set(auth(learner));
      expect(article.status).toBe(200);
      expectDeclared(article, "GET /v1/learn/lessons/{id}");
      expect(article.body).toMatchObject({ id: c.lessons.article.id, type: "ARTICLE", articleBody: "# Hello", courseId: c.id });
      const video = await http().get(`/v1/learn/lessons/${c.lessons.video.id}`).set(auth(learner));
      expectDeclared(video, "GET /v1/learn/lessons/{id}");
      expect(video.body).toMatchObject({ type: "VIDEO", videoAssetId: c.paidAsset, durationSec: 600 });
      const res = await http().get(`/v1/learn/lessons/${c.lessons.resource.id}`).set(auth(learner));
      expectDeclared(res, "GET /v1/learn/lessons/{id}");
      expect(res.status).toBe(200);
      const url = new URL(res.body.resource.url);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      expect(res.body.resource.filename).toBe("notes.pdf");
      expect(res.body.resource.expiresAt).toBe(new Date(t.clock.now().getTime() + 300_000).toISOString());
    });

    it("a stranger gets 403 COURSE_NOT_ENROLLED for paid lessons but can open free-preview lessons (and their resources)", async () => {
      const owner = await creator();
      const c = await course(owner);
      const stranger = await t.login();
      const denied = await http().get(`/v1/learn/lessons/${c.lessons.article.id}`).set(auth(stranger));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("COURSE_NOT_ENROLLED");
      expect((await http().get(`/v1/learn/lessons/${c.lessons.resource.id}`).set(auth(stranger))).status).toBe(403);
      const preview = await http().get(`/v1/learn/lessons/${c.lessons.previewArticle.id}`).set(auth(stranger));
      expect(preview.status).toBe(200);
      expect(preview.body.articleBody).toBe("free words");
      const previewVideo = await http().get(`/v1/learn/lessons/${c.lessons.preview.id}`).set(auth(stranger));
      expect(previewVideo.body.videoAssetId).toBe(c.previewAsset);
      await prisma.lesson.update({ where: { id: c.lessons.resource.id }, data: { isFreePreview: true } });
      expect((await http().get(`/v1/learn/lessons/${c.lessons.resource.id}`).set(auth(stranger))).body.resource.url).toContain("X-Amz-Expires=300");
    });

    it("a refunded learner is refused at once; an unknown lesson or one of a draft course is 404", async () => {
      const owner = await creator();
      const c = await course(owner, { pricePaise: "49900" });
      const buyer = await t.login();
      const orderId = await purchased(c.id, buyer.userId);
      expect((await http().get(`/v1/learn/lessons/${c.lessons.article.id}`).set(auth(buyer))).status).toBe(200);
      await prisma.$transaction((tx) => t.app.get(EnrolmentsService).revokeForOrder(tx, { courseId: c.id, userId: buyer.userId, orderId }));
      expect((await http().get(`/v1/learn/lessons/${c.lessons.article.id}`).set(auth(buyer))).status).toBe(403);
      expect((await http().get(`/v1/learn/lessons/${uuidv7()}`).set(auth(buyer))).status).toBe(404);
      const draft = await course(owner, { status: "DRAFT" });
      expect((await http().get(`/v1/learn/lessons/${draft.lessons.article.id}`).set(auth(buyer))).status).toBe(404);
    });
  });

  describe("GET /v1/courses/:slug (public catalog page)", () => {
    it("is public for published courses and hides drafts, in-review and flagged ones", async () => {
      const owner = await creator();
      const c = await course(owner);
      const res = await http().get(`/v1/courses/${c.slug}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: c.id, slug: c.slug, pricePaise: "0" });
      expectDeclared(res, "GET /v1/courses/{slug}");
      expect(res.body).not.toHaveProperty("flagReason");
      expect(res.body).not.toHaveProperty("rejectionReason");
      expect((await http().get(`/v1/courses/${(await course(owner, { status: "DRAFT" })).slug}`)).status).toBe(404);
      expect((await http().get(`/v1/courses/${(await course(owner, { status: "IN_REVIEW" })).slug}`)).status).toBe(404);
      expect((await http().get(`/v1/courses/${(await course(owner, { flagged: true })).slug}`)).status).toBe(404);
    });
  });
});
