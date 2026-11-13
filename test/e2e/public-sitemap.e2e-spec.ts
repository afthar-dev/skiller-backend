import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { expectDeclared } from "../support/openapi-shape";

interface Item {
  slug: string;
  updatedAt: string;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("public sitemap feed", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const get = (path: string) => http().get(path).set("X-Forwarded-For", uniqueIp());
  const KEY = "GET /v1/public/sitemap/{kind}";

  /** Every page of a kind, following nextCursor to the end. */
  async function all(kind: string): Promise<Item[]> {
    const out: Item[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await get(`/v1/public/sitemap/${kind}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      expectDeclared(res, KEY);
      out.push(...(res.body as Page).items);
      cursor = (res.body as Page).nextCursor;
    } while (cursor);
    return out;
  }

  /** A user with a profile; `chosenName` false leaves the display name the email made. */
  async function person(over: { status?: "ACTIVE" | "SUSPENDED"; chosenName?: boolean } = {}) {
    const email = `${uniq()}@example.com`;
    const user = await prisma.user.create({ data: { email, status: over.status ?? "ACTIVE" } });
    const handle = `h${uniq()}`;
    await prisma.profile.create({ data: { userId: user.id, handle, displayName: over.chosenName === false ? email.split("@")[0] : `Name ${uniq()}` } });
    return { id: user.id, handle };
  }
  const course = (ownerId: string, over: Record<string, unknown> = {}) =>
    prisma.course.create({
      data: { ownerType: "USER", ownerId, createdById: ownerId, slug: `c-${uniq()}`, title: "Course", categoryId, language: "en", status: "PUBLISHED", publishedAt: new Date(), tags: [], ...over },
    });
  const gig = (sellerId: string, over: Record<string, unknown> = {}) =>
    prisma.gig.create({ data: { sellerId, slug: `g-${uniq()}`, title: "Gig", categoryId, tags: [], status: "ACTIVE", publishedAt: new Date(), ...over } });
  async function reel(creatorId: string, hashtags: string[], status: "PUBLISHED" | "HIDDEN" | "REMOVED" | "PROCESSING" | "DELETED" = "PUBLISHED") {
    const asset = await prisma.mediaAsset.create({
      data: { ownerId: creatorId, purpose: "REEL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 30 },
    });
    for (const tag of hashtags) await prisma.hashtag.upsert({ where: { tag }, create: { tag, reelCount: 1, lastUsedAt: new Date() }, update: {} });
    return prisma.reel.create({ data: { creatorId, mediaAssetId: asset.id, hashtags, status, publishedAt: status === "PUBLISHED" ? new Date() : null } });
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.create({ data: { slug: `cat-${uniq()}`, name: `Sitemap ${uniq()}` } })).id;
  });
  afterAll(async () => {
    await t.close();
  });

  it("answers 404 for an unknown kind and 400 for a cursor that is not ours", async () => {
    const res = await get("/v1/public/sitemap/reels");
    expect(res.status).toBe(404);
    expect(res.body.code ?? res.body.error?.code).toBe("SITEMAP_KIND_NOT_FOUND");
    expect((await get("/v1/public/sitemap/courses?cursor=garbage")).status).toBe(400);
  });

  describe("courses", () => {
    it("lists a published course with updatedAt and none that is draft, in review, archived, flagged or unpublished", async () => {
      const owner = await person();
      const published = await course(owner.id);
      const draft = await course(owner.id, { status: "DRAFT", publishedAt: null });
      const review = await course(owner.id, { status: "IN_REVIEW", publishedAt: null });
      const archived = await course(owner.id, { status: "ARCHIVED" });
      const flagged = await course(owner.id, { flaggedAt: new Date() });
      const noDate = await course(owner.id, { publishedAt: null });
      const items = await all("courses");
      const found = items.find((i) => i.slug === published.slug);
      expect(found?.updatedAt).toBe(published.updatedAt.toISOString());
      const listed = new Set(items.map((i) => i.slug));
      for (const hidden of [draft, review, archived, flagged, noDate]) expect(listed.has(hidden.slug)).toBe(false);
    });

    it("pages by 1,000 without duplicates or gaps", async () => {
      const owner = await person();
      const prefix = `page-${uniq()}-`;
      const rows = Array.from({ length: 1005 }, (_, i) => ({
        ownerType: "USER" as const,
        ownerId: owner.id,
        createdById: owner.id,
        slug: `${prefix}${String(i).padStart(4, "0")}`,
        title: "Bulk",
        categoryId,
        language: "en",
        status: "PUBLISHED" as const,
        publishedAt: new Date(),
        tags: [],
      }));
      await prisma.course.createMany({ data: rows });
      const first = await get("/v1/public/sitemap/courses");
      expect(first.status).toBe(200);
      expect((first.body as Page).items).toHaveLength(1000);
      const cursor = (first.body as Page).nextCursor;
      expect(cursor).toEqual(expect.any(String));
      // A cursor is bound to its kind.
      expect((await get(`/v1/public/sitemap/gigs?cursor=${encodeURIComponent(cursor!)}`)).status).toBe(400);
      const items = await all("courses");
      const list = items.map((i) => i.slug);
      expect(new Set(list).size).toBe(list.length);
      expect([...list]).toEqual([...list].sort());
      const mine = list.filter((s) => s.startsWith(prefix));
      expect(mine).toHaveLength(1005);
    });
  });

  describe("gigs", () => {
    it("lists a live gig of an active seller and none that is draft, paused, hidden, removed or whose seller is suspended", async () => {
      const seller = await person();
      const suspended = await person({ status: "SUSPENDED" });
      const live = await gig(seller.id);
      const hiddenOnes = [
        await gig(seller.id, { status: "DRAFT", publishedAt: null }),
        await gig(seller.id, { status: "PAUSED" }),
        await gig(seller.id, { status: "HIDDEN" }),
        await gig(seller.id, { status: "REMOVED" }),
        await gig(seller.id, { status: "DELETED" }),
        await gig(suspended.id),
      ];
      const items = await all("gigs");
      expect(items.find((i) => i.slug === live.slug)?.updatedAt).toBe(live.updatedAt.toISOString());
      const listed = new Set(items.map((i) => i.slug));
      for (const g of hiddenOnes) expect(listed.has(g.slug)).toBe(false);
    });
  });

  describe("profiles", () => {
    it("lists an active profile with a public item or a chosen name, and none that is suspended or empty with the email-made name", async () => {
      const named = await person();
      const withCourse = await person({ chosenName: false });
      await course(withCourse.id);
      const withGig = await person({ chosenName: false });
      await gig(withGig.id);
      const withReel = await person({ chosenName: false });
      await reel(withReel.id, []);
      const empty = await person({ chosenName: false });
      const withDraftOnly = await person({ chosenName: false });
      await course(withDraftOnly.id, { status: "DRAFT", publishedAt: null });
      await gig(withDraftOnly.id, { status: "REMOVED" });
      await reel(withDraftOnly.id, [], "REMOVED");
      const suspended = await person({ status: "SUSPENDED" });
      await course(suspended.id);

      const items = await all("profiles");
      const listed = new Set(items.map((i) => i.slug));
      for (const p of [named, withCourse, withGig, withReel]) expect(listed.has(p.handle)).toBe(true);
      for (const p of [empty, withDraftOnly, suspended]) expect(listed.has(p.handle)).toBe(false);
      const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: named.id } });
      expect(items.find((i) => i.slug === named.handle)?.updatedAt).toBe(profile.updatedAt.toISOString());
    });
  });

  describe("categories", () => {
    it("lists an active category with a published course, with the latest course update, and none that is empty, inactive or has only unpublished courses", async () => {
      const owner = await person();
      const mk = (over: Record<string, unknown> = {}) => prisma.category.create({ data: { slug: `cat-${uniq()}`, name: `C ${uniq()}`, ...over } });
      const good = await mk();
      const empty = await mk();
      const inactive = await mk({ isActive: false });
      const draftOnly = await mk();
      const flaggedOnly = await mk();
      await course(owner.id, { categoryId: good.id });
      const newest = await course(owner.id, { categoryId: good.id });
      await course(owner.id, { categoryId: inactive.id });
      await course(owner.id, { categoryId: draftOnly.id, status: "DRAFT", publishedAt: null });
      await course(owner.id, { categoryId: flaggedOnly.id, flaggedAt: new Date() });

      const items = await all("categories");
      const listed = new Set(items.map((i) => i.slug));
      expect(listed.has(good.slug)).toBe(true);
      for (const c of [empty, inactive, draftOnly, flaggedOnly]) expect(listed.has(c.slug)).toBe(false);
      const latest = await prisma.course.aggregate({ where: { categoryId: good.id }, _max: { updatedAt: true } });
      expect(items.find((i) => i.slug === good.slug)?.updatedAt).toBe(latest._max.updatedAt!.toISOString());
      expect(newest.updatedAt.getTime()).toBeLessThanOrEqual(latest._max.updatedAt!.getTime());
    });
  });

  describe("hashtags", () => {
    it("lists a tag on a published reel of an active creator and none whose reels are hidden, removed, unfinished or by a suspended creator", async () => {
      const creator = await person();
      const suspended = await person({ status: "SUSPENDED" });
      const tag = (name: string) => `${name}${uniq()}`;
      const live = tag("live");
      const hidden = tag("hidden");
      const removed = tag("removed");
      const processing = tag("processing");
      const gone = tag("gone");
      const unused = tag("unused");
      await reel(creator.id, [live]);
      await reel(creator.id, [hidden], "HIDDEN");
      await reel(creator.id, [removed], "REMOVED");
      await reel(creator.id, [processing], "PROCESSING");
      await reel(suspended.id, [gone]);
      await prisma.hashtag.create({ data: { tag: unused, reelCount: 0, lastUsedAt: new Date() } });

      const items = await all("hashtags");
      const listed = new Set(items.map((i) => i.slug));
      expect(listed.has(live)).toBe(true);
      for (const h of [hidden, removed, processing, gone, unused]) expect(listed.has(h)).toBe(false);
      const row = await prisma.hashtag.findUniqueOrThrow({ where: { tag: live } });
      expect(items.find((i) => i.slug === live)?.updatedAt).toBe(row.lastUsedAt.toISOString());
    });
  });

});
