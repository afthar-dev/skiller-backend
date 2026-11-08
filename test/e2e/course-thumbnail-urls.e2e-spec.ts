import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { refreshCourseSearch } from "../../src/modules/courses/course-search";
import { MediaService } from "../../src/modules/media";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { expectDeclared } from "../support/openapi-shape";

/** Course cards, the course page, my learning list, the player view and the enrol answer carry the thumbnail's public URL next to its asset id. */
describe("course thumbnail URLs", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const base = () => process.env.R2_PUBLIC_BASE_URL as string;

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  interface Thumb {
    status?: "READY" | "PROCESSING";
    bucket?: "PUBLIC" | "PRIVATE";
  }
  /** A thumbnail asset as the image worker leaves it: two webp renditions keyed by width. */
  async function thumb(over: Thumb = {}) {
    const id = uuidv7();
    const row = await prisma.mediaAsset.create({
      data: {
        id,
        ownerId: `owner-${uniq()}`,
        purpose: "THUMBNAIL",
        bucket: over.bucket ?? "PUBLIC",
        status: over.status ?? "READY",
        objectKey: `incoming/${id}/source`,
        mime: "image/png",
        declaredSize: 10n,
        width: 1920,
        height: 1080,
        renditions: { "256": `thumbnail/${id}/256.webp`, "1024": `thumbnail/${id}/1024.webp` },
      },
    });
    return { row, url: `${base()}/thumbnail/${id}/1024.webp` };
  }
  async function course(categoryId: string, thumbnailAssetId: string | null) {
    const c = await prisma.course.create({
      data: {
        ownerType: "USER",
        ownerId: `owner-${uniq()}`,
        ownerName: "Some Creator",
        slug: `c-${uniq()}-${uniq()}`,
        title: `Thumb ${uniq()}`,
        description: "",
        tags: [],
        categoryId,
        level: "ALL",
        language: "en",
        pricePaise: 0n,
        status: "PUBLISHED",
        publishedAt: new Date(),
        slugLockedAt: new Date(),
        createdById: "creator-x",
        thumbnailAssetId,
      },
    });
    await refreshCourseSearch(prisma, c.id);
    return c;
  }
  const category = () => prisma.category.create({ data: { slug: `cat-${uniq()}`, name: `Thumbs ${uniq()}` } });

  it("adds thumbnailUrl (the 1024 px rendition) to catalog cards with one lookup per page, null for missing, not-ready and private assets", async () => {
    const cat = await category();
    const ready = await thumb();
    const processing = await thumb({ status: "PROCESSING" });
    const priv = await thumb({ bucket: "PRIVATE" });
    const a = await course(cat.id, ready.row.id);
    const b = await course(cat.id, processing.row.id);
    const c = await course(cat.id, priv.row.id);
    const d = await course(cat.id, null);
    const e = await course(cat.id, uuidv7()); // dangling reference

    const spy = jest.spyOn(t.app.get(MediaService), "publicUrls");
    try {
      const res = await http().get(`/v1/courses?category=${cat.slug}&limit=20`).set("X-Forwarded-For", uniqueIp());
      expect(res.status).toBe(200);
      expectDeclared(res, "GET /v1/courses");
      expect(spy).toHaveBeenCalledTimes(1);
      const byId = new Map((res.body.items as { id: string; thumbnailUrl: string | null; thumbnailAssetId: string | null }[]).map((x) => [x.id, x]));
      expect(byId.get(a.id)).toMatchObject({ thumbnailAssetId: ready.row.id, thumbnailUrl: ready.url });
      expect(byId.get(b.id)).toMatchObject({ thumbnailAssetId: processing.row.id, thumbnailUrl: null });
      expect(byId.get(c.id)).toMatchObject({ thumbnailUrl: null });
      expect(byId.get(d.id)).toMatchObject({ thumbnailAssetId: null, thumbnailUrl: null });
      expect(byId.get(e.id)).toMatchObject({ thumbnailUrl: null });
    } finally {
      spy.mockRestore();
    }
  });

  it("adds thumbnailUrl to the course page", async () => {
    const cat = await category();
    const ready = await thumb();
    const withThumb = await course(cat.id, ready.row.id);
    const without = await course(cat.id, null);
    const res = await http().get(`/v1/courses/${withThumb.slug}`);
    expectDeclared(res, "GET /v1/courses/{slug}");
    expect(res.body).toMatchObject({ thumbnailAssetId: ready.row.id, thumbnailUrl: ready.url });
    const bare = await http().get(`/v1/courses/${without.slug}`);
    expectDeclared(bare, "GET /v1/courses/{slug}");
    expect(bare.body.thumbnailUrl).toBeNull();
  });

  it("adds thumbnailUrl to my learning list (one lookup per page), the enrol answer and the player's course view", async () => {
    const cat = await category();
    const ready = await thumb();
    const processing = await thumb({ status: "PROCESSING" });
    const withThumb = await course(cat.id, ready.row.id);
    const notReady = await course(cat.id, processing.row.id);
    const none = await course(cat.id, null);
    const learner = await t.login();
    for (const c of [withThumb, notReady]) await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(learner)).expect(201);

    const enrol = await http().post(`/v1/courses/${none.slug}/enrol`).set(auth(learner));
    expect(enrol.status).toBe(201);
    expectDeclared(enrol, "POST /v1/courses/{slug}/enrol");
    expect(enrol.body.thumbnailUrl).toBeNull();
    const again = await http().post(`/v1/courses/${withThumb.slug}/enrol`).set(auth(learner));
    expect(again.status).toBe(200);
    expect(again.body.thumbnailUrl).toBe(ready.url);

    const spy = jest.spyOn(t.app.get(MediaService), "publicUrls");
    try {
      const res = await http().get("/v1/me/learning").set(auth(learner));
      expect(res.status).toBe(200);
      expectDeclared(res, "GET /v1/me/learning");
      expect(spy).toHaveBeenCalledTimes(1);
      const bySlug = new Map((res.body.items as { courseSlug: string; thumbnailUrl: string | null; thumbnailAssetId: string | null }[]).map((x) => [x.courseSlug, x]));
      expect(bySlug.get(withThumb.slug)).toMatchObject({ thumbnailAssetId: ready.row.id, thumbnailUrl: ready.url });
      expect(bySlug.get(notReady.slug)).toMatchObject({ thumbnailUrl: null });
      expect(bySlug.get(none.slug)).toMatchObject({ thumbnailAssetId: null, thumbnailUrl: null });
    } finally {
      spy.mockRestore();
    }

    const learn = await http().get(`/v1/learn/courses/${withThumb.slug}`).set(auth(learner));
    expect(learn.status).toBe(200);
    expectDeclared(learn, "GET /v1/learn/courses/{slug}");
    expect(learn.body.course.thumbnailUrl).toBe(ready.url);
    const learnNone = await http().get(`/v1/learn/courses/${notReady.slug}`).set(auth(learner));
    expect(learnNone.body.course.thumbnailUrl).toBeNull();
  });
});
