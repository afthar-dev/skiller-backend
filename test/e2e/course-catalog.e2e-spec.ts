import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import type { DomainEvent } from "../../src/common/outbox/events";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { CatalogCursor } from "../../src/modules/courses/catalog-cursor";
import { CoursePopularity } from "../../src/modules/courses/course-popularity";
import { refreshCourseSearch } from "../../src/modules/courses/course-search";
import { OrganizationsService } from "../../src/modules/organizations/organizations.service";
import { ProfilesService } from "../../src/modules/users";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

interface Card {
  id: string;
  slug: string;
  title: string;
  ratingAvg: number | null;
  ownerName: string;
}

describe("course search and catalog", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  const http = () => request(t.app.getHttpServer());
  const uniq = () => Math.random().toString(36).slice(2, 10);
  /** Each test searches inside a category of its own, so the courses other tests (and earlier runs) left behind never show up. */
  const category = () => prisma.category.create({ data: { slug: `cat-${uniq()}`, name: `Catalog ${uniq()}` } });

  interface Spec {
    title: string;
    subtitle?: string;
    description?: string;
    tags?: string[];
    ownerName?: string;
    ownerType?: "USER" | "ORG";
    ownerId?: string;
    level?: "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "ALL";
    language?: string;
    pricePaise?: bigint;
    status?: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "ARCHIVED";
    flagged?: boolean;
    publishedAt?: Date;
    ratingAvg?: string;
    ratingCount?: number;
    enrolments30d?: number;
    enrolmentCount?: number;
  }
  async function course(categoryId: string, s: Spec) {
    const c = await prisma.course.create({
      data: {
        ownerType: s.ownerType ?? "USER",
        ownerId: s.ownerId ?? `owner-${uniq()}`,
        ownerName: s.ownerName ?? "Some Creator",
        slug: `c-${uniq()}-${uniq()}`,
        title: s.title,
        subtitle: s.subtitle ?? null,
        description: s.description ?? "",
        tags: s.tags ?? [],
        categoryId,
        level: s.level ?? "ALL",
        language: s.language ?? "en",
        pricePaise: s.pricePaise ?? 0n,
        status: s.status ?? "PUBLISHED",
        flaggedAt: s.flagged ? new Date() : null,
        publishedAt: s.publishedAt ?? new Date(),
        slugLockedAt: new Date(),
        createdById: "creator-x",
        ratingAvg: s.ratingAvg ?? null,
        ratingCount: s.ratingCount ?? 0,
        enrolments30d: s.enrolments30d ?? 0,
        enrolmentCount: s.enrolmentCount ?? 0,
      },
    });
    await refreshCourseSearch(prisma, c.id);
    return c;
  }
  const search = (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)])).toString();
    return http().get(`/v1/courses?${qs}`).set("X-Forwarded-For", uniqueIp());
  };
  const titles = (res: { body: { items: Card[] } }) => res.body.items.map((c) => c.title);
  /** Walks every page of a query and returns the ids in order. */
  async function walk(params: Record<string, string | number | undefined>, limit = 2) {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const res = await search({ ...params, limit, cursor });
      expect(res.status).toBe(200);
      ids.push(...res.body.items.map((c: Card) => c.id));
      if (!res.body.nextCursor) return ids;
      cursor = res.body.nextCursor;
    }
    throw new Error("pagination did not end");
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
  });
  afterAll(() => t?.close());

  describe("text search", () => {
    it("finds a title through a typo: \"javascrpt\" finds JavaScript", async () => {
      const cat = await category();
      const hit = await course(cat.id, { title: "JavaScript Essentials" });
      await course(cat.id, { title: "Baking Sourdough" });
      const res = await search({ q: "javascrpt", category: cat.slug });
      expect(res.status).toBe(200);
      expect(titles(res)).toEqual(["JavaScript Essentials"]);
      expect(res.body.items[0].id).toBe(hit.id);
      // Half a word of a long title still finds it.
      const two = await course(cat.id, { title: "Advanced JavaScript for Backend Engineers" });
      expect(res.status).toBe(200);
      expect((await search({ q: "javascrpt", category: cat.slug })).body.items.map((c: Card) => c.id)).toEqual(expect.arrayContaining([hit.id, two.id]));
    });

    it("matches whole words in title, subtitle, tags, description and the creator's name; the title ranks first", async () => {
      const cat = await category();
      const word = `quark${uniq()}`;
      const inTitle = await course(cat.id, { title: `Intro to ${word}` });
      const inTags = await course(cat.id, { title: "Tag match", tags: [word] });
      const inDescription = await course(cat.id, { title: "Description match", description: `All about ${word} and more` });
      const byOwner = await course(cat.id, { title: "Owner match", ownerName: `Dr ${word}` });
      await course(cat.id, { title: "Unrelated" });
      const res = await search({ q: word, category: cat.slug });
      const ids = res.body.items.map((c: Card) => c.id);
      expect(ids[0]).toBe(inTitle.id);
      expect(new Set(ids)).toEqual(new Set([inTitle.id, inTags.id, inDescription.id, byOwner.id]));
      expect(ids.indexOf(inTags.id)).toBeLessThan(ids.indexOf(inDescription.id)); // tags weigh B, description C
      // websearch syntax: a minus sign excludes
      expect((await search({ q: `${word} -tag`, category: cat.slug })).body.items.map((c: Card) => c.title)).not.toContain("Tag match");
    });

    it("matches an exact word with the simple configuration", async () => {
      const cat = await category();
      await course(cat.id, { title: "Running for beginners" });
      const exact = await search({ q: "running", category: cat.slug });
      expect(titles(exact)).toEqual(["Running for beginners"]);
    });

    it("finds Devanagari text", async () => {
      const cat = await category();
      await course(cat.id, { title: "पायथन प्रोग्रामिंग", description: "शुरुआती के लिए" });
      expect(titles(await search({ q: "प्रोग्रामिंग", category: cat.slug }))).toEqual(["पायथन प्रोग्रामिंग"]);
    });

    it("returns nothing for a query that matches nothing, even fuzzily, and ignores punctuation-only input", async () => {
      const cat = await category();
      await course(cat.id, { title: "Sourdough Baking" });
      expect((await search({ q: "zzzzqqqq", category: cat.slug })).body.items).toEqual([]);
      expect((await search({ q: "!!!", category: cat.slug })).status).toBe(200);
    });
  });

  describe("visibility", () => {
    it("never returns draft, in-review, archived or flagged courses", async () => {
      const cat = await category();
      const word = `vis${uniq()}`;
      const live = await course(cat.id, { title: `${word} live` });
      for (const status of ["DRAFT", "IN_REVIEW", "ARCHIVED"] as const) await course(cat.id, { title: `${word} ${status}`, status });
      await course(cat.id, { title: `${word} flagged`, flagged: true });
      for (const params of [{ category: cat.slug }, { q: word, category: cat.slug }, { q: word, category: cat.slug, sort: "newest" }, { category: cat.slug, sort: "rating" }, { category: cat.slug, sort: "popular" }]) {
        const res = await search(params);
        expect(res.body.items.map((c: Card) => c.id)).toEqual([live.id]);
      }
      expect((await walk({ category: cat.slug })).length).toBe(1);
    });

    it("serves the public detail page only for live courses, with the 3-ratings rule and the owner name", async () => {
      const cat = await category();
      const live = await course(cat.id, { title: "Detail", ownerName: "Asha Verma", ratingAvg: "4.50", ratingCount: 2 });
      const rated = await course(cat.id, { title: "Detail rated", ratingAvg: "4.50", ratingCount: 3 });
      const draft = await course(cat.id, { title: "Detail draft", status: "DRAFT" });
      const flagged = await course(cat.id, { title: "Detail flagged", flagged: true });
      const page = await http().get(`/v1/courses/${live.slug}`);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ ownerName: "Asha Verma", ratingAvg: null, ratingCount: 2 });
      expect((await http().get(`/v1/courses/${rated.slug}`)).body).toMatchObject({ ratingAvg: 4.5, ratingCount: 3 });
      expect((await http().get(`/v1/courses/${draft.slug}`)).status).toBe(404);
      expect((await http().get(`/v1/courses/${flagged.slug}`)).status).toBe(404);
    });

    it("lists the categories without signing in", async () => {
      const res = await http().get("/v1/categories");
      expect(res.status).toBe(200);
      expect(res.body.items.map((c: { slug: string }) => c.slug)).toContain("development");
    });
  });

  describe("filters", () => {
    it("combine: category, level, language, price, price range and minimum rating", async () => {
      const cat = await category();
      const other = await category();
      const a = await course(cat.id, { title: "A", level: "BEGINNER", language: "en", pricePaise: 0n });
      const b = await course(cat.id, { title: "B", level: "BEGINNER", language: "hi", pricePaise: 49900n, ratingAvg: "4.60", ratingCount: 5 });
      const c = await course(cat.id, { title: "C", level: "ADVANCED", language: "en", pricePaise: 99900n, ratingAvg: "3.90", ratingCount: 9 });
      const d = await course(cat.id, { title: "D", level: "ADVANCED", language: "en", pricePaise: 150000n, ratingAvg: "4.90", ratingCount: 2 });
      await course(other.id, { title: "E", level: "BEGINNER", language: "en" });
      const ids = async (p: Record<string, string>) => new Set((await search({ category: cat.slug, ...p })).body.items.map((x: Card) => x.id));
      expect(await ids({})).toEqual(new Set([a.id, b.id, c.id, d.id]));
      expect(await ids({ level: "BEGINNER" })).toEqual(new Set([a.id, b.id]));
      expect(await ids({ language: "hi" })).toEqual(new Set([b.id]));
      expect(await ids({ price: "free" })).toEqual(new Set([a.id]));
      expect(await ids({ price: "paid" })).toEqual(new Set([b.id, c.id, d.id]));
      expect(await ids({ minPrice: "50000", maxPrice: "100000" })).toEqual(new Set([c.id]));
      expect(await ids({ minPrice: "49900" })).toEqual(new Set([b.id, c.id, d.id]));
      expect(await ids({ minRating: "4" })).toEqual(new Set([b.id])); // d has a 4.9 average but only 2 ratings: not shown, not filterable
      expect(await ids({ level: "ADVANCED", price: "paid", minRating: "3.5" })).toEqual(new Set([c.id]));
      expect(await ids({ level: "BEGINNER", language: "en", price: "paid" })).toEqual(new Set());
      expect((await search({ category: `nope-${uniq()}` })).body.items).toEqual([]);
    });

    it("rejects bad parameters with 400", async () => {
      for (const bad of [{ level: "EXPERT" }, { language: "xx" }, { price: "cheap" }, { minPrice: "-1" }, { minPrice: "100", maxPrice: "50" }, { minRating: "9" }, { sort: "random" }, { cursor: "not-a-cursor" }]) {
        expect((await search(bad)).status).toBe(400);
      }
    });

    it("shows a card without the long description and with the rating rule", async () => {
      const cat = await category();
      await course(cat.id, { title: "Card", description: "long text", ratingAvg: "4.00", ratingCount: 1 });
      const [card] = (await search({ category: cat.slug })).body.items;
      expect(card).toMatchObject({ title: "Card", ratingAvg: null, ratingCount: 1, pricePaise: "0", ownerName: "Some Creator" });
      expect(card).not.toHaveProperty("description");
    });
  });

  describe("sorting and cursors", () => {
    const sameInstant = new Date("2026-06-01T10:00:00.000Z");

    it("newest: ties on the publish time break by id, every page boundary is exact, a course added between pages never duplicates one", async () => {
      const cat = await category();
      const made = [];
      for (let i = 0; i < 7; i++) made.push(await course(cat.id, { title: `N${i}`, publishedAt: i < 5 ? sameInstant : new Date(sameInstant.getTime() + i * 1000) }));
      const all = (await search({ category: cat.slug, sort: "newest", limit: 100 })).body.items.map((c: Card) => c.id);
      expect(all).toHaveLength(7);
      expect(all.slice(0, 2)).toEqual([made[6].id, made[5].id]); // newest first
      expect(await walk({ category: cat.slug, sort: "newest" })).toEqual(all);
      expect(await walk({ category: cat.slug, sort: "newest" }, 3)).toEqual(all);
      expect(await walk({ category: cat.slug, sort: "newest" }, 1)).toEqual(all);

      const p1 = await search({ category: cat.slug, sort: "newest", limit: 3 });
      const fresh = await course(cat.id, { title: "Fresh", publishedAt: new Date(sameInstant.getTime() + 60_000) });
      const p2 = await search({ category: cat.slug, sort: "newest", limit: 100, cursor: p1.body.nextCursor });
      expect([...p1.body.items, ...p2.body.items].map((c: Card) => c.id)).toEqual(all);
      expect(p2.body.items.map((c: Card) => c.id)).not.toContain(fresh.id);
    });

    it("popular: most enrolments of the last 30 days first, then all-time enrolments, then id; pages are exact", async () => {
      const cat = await category();
      const rows = [
        { title: "P0", enrolments30d: 5, enrolmentCount: 5 },
        { title: "P1", enrolments30d: 5, enrolmentCount: 50 },
        { title: "P2", enrolments30d: 0, enrolmentCount: 900 },
        { title: "P3", enrolments30d: 0, enrolmentCount: 0 },
        { title: "P4", enrolments30d: 0, enrolmentCount: 0 },
        { title: "P5", enrolments30d: 9, enrolmentCount: 9 },
      ];
      for (const r of rows) await course(cat.id, r);
      const all = (await search({ category: cat.slug, sort: "popular", limit: 100 })).body.items as Card[];
      expect(all.slice(0, 4).map((c) => c.title)).toEqual(["P5", "P1", "P0", "P2"]);
      expect(await walk({ category: cat.slug, sort: "popular" })).toEqual(all.map((c) => c.id));
      expect(await walk({ category: cat.slug, sort: "popular" }, 1)).toEqual(all.map((c) => c.id));
    });

    it("rating: shown ratings first, courses with fewer than 3 ratings after them; pages are exact", async () => {
      const cat = await category();
      const rows = [
        { title: "R0", ratingAvg: "4.50", ratingCount: 10 },
        { title: "R1", ratingAvg: "4.50", ratingCount: 30 },
        { title: "R2", ratingAvg: "5.00", ratingCount: 2 }, // hidden rating: counts as unrated
        { title: "R3", ratingAvg: "3.00", ratingCount: 3 },
        { title: "R4" },
        { title: "R5" },
      ];
      for (const r of rows) await course(cat.id, r);
      const all = (await search({ category: cat.slug, sort: "rating", limit: 100 })).body.items as Card[];
      expect(all.slice(0, 3).map((c) => c.title)).toEqual(["R1", "R0", "R3"]);
      expect(all.slice(3).map((c) => c.title).sort()).toEqual(["R2", "R4", "R5"]);
      expect(await walk({ category: cat.slug, sort: "rating" })).toEqual(all.map((c) => c.id));
      expect(await walk({ category: cat.slug, sort: "rating" }, 1)).toEqual(all.map((c) => c.id));
    });

    it("relevance: exact title matches first, equal scores break by id, pages are exact, in full-text and in fuzzy mode", async () => {
      const cat = await category();
      const word = `stable${uniq()}`;
      for (let i = 0; i < 5; i++) await course(cat.id, { title: `${word} guide`, description: i % 2 ? `${word}` : "" });
      await course(cat.id, { title: `Other ${word}` });
      await course(cat.id, { title: "Mentions it", description: `about ${word}` });
      for (const q of [word, word.replace("stable", "stabel")]) {
        const all = (await search({ category: cat.slug, q, sort: "relevance", limit: 100 })).body.items as Card[];
        expect(all.length).toBeGreaterThanOrEqual(5);
        expect(await walk({ category: cat.slug, q, sort: "relevance" })).toEqual(all.map((c) => c.id));
        expect(await walk({ category: cat.slug, q, sort: "relevance" }, 1)).toEqual(all.map((c) => c.id));
        expect(await walk({ category: cat.slug, q, sort: "newest" })).toHaveLength(all.length);
      }
    });

    it("relevance without a text query shows what is popular", async () => {
      const cat = await category();
      await course(cat.id, { title: "Quiet", enrolments30d: 0 });
      await course(cat.id, { title: "Busy", enrolments30d: 4 });
      expect(titles(await search({ category: cat.slug }))).toEqual(["Busy", "Quiet"]);
    });

    it("rejects forged cursors with 400, never 500: wrong hash, overflowing keys, impossible dates, a forged mode", async () => {
      const cat = await category();
      for (let i = 0; i < 3; i++) await course(cat.id, { title: `Forge ${i}`, enrolments30d: i });
      const codec = t.app.get(CatalogCursor);
      const real = async (params: Record<string, string | number>) => codec.verify((await search({ ...params, limit: 1 })).body.nextCursor);
      const bad = async (params: Record<string, string | number>, cursor: string) => {
        const res = await search({ ...params, limit: 1, cursor });
        return [res.status, res.body.error?.code];
      };
      const popular = { category: cat.slug, sort: "popular" };
      const p = await real(popular);
      // A cursor this server did not sign: even with the right query hash.
      const unsigned = Buffer.from(JSON.stringify(p)).toString("base64url");
      expect(await bad(popular, unsigned)).toEqual([400, "BAD_CURSOR"]);
      expect(await bad(popular, `${unsigned}.AAAA`)).toEqual([400, "BAD_CURSOR"]);
      // Signed, right hash, but out-of-range keys (these used to reach the database and fail there).
      expect(await bad(popular, codec.sign({ ...p, k: ["9999999999", "1"] }))).toEqual([400, "BAD_CURSOR"]);
      const newest = { category: cat.slug, sort: "newest" };
      const n = await real(newest);
      expect(await bad(newest, codec.sign({ ...n, k: ["9999-99-99 99:99:99"] }))).toEqual([400, "BAD_CURSOR"]);
      expect(await bad(newest, codec.sign({ ...n, k: ["2026-02-30 10:00:00"] }))).toEqual([400, "BAD_CURSOR"]);
      // A forged mode: none with a text query, or fts / trgm without one.
      const withQ = { category: cat.slug, q: "forge", sort: "newest" };
      const f = await real(withQ);
      expect(await bad(withQ, codec.sign({ ...f, m: "none" }))).toEqual([400, "BAD_CURSOR"]);
      expect(await bad(newest, codec.sign({ ...n, m: "fts" }))).toEqual([400, "BAD_CURSOR"]);
      // The genuine ones still work.
      expect((await search({ ...popular, limit: 1, cursor: codec.sign(p) })).status).toBe(200);
    });

    it("rejects a cursor that belongs to another query", async () => {
      const cat = await category();
      for (let i = 0; i < 3; i++) await course(cat.id, { title: `Cur ${i}` });
      const p1 = await search({ category: cat.slug, sort: "newest", limit: 1 });
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      expect((await search({ category: cat.slug, sort: "popular", limit: 1, cursor: p1.body.nextCursor })).status).toBe(400);
      expect((await search({ category: cat.slug, sort: "newest", level: "BEGINNER", limit: 1, cursor: p1.body.nextCursor })).status).toBe(400);
      const forged = Buffer.from(JSON.stringify({ v: 1, s: "newest", m: "none", h: "x".repeat(12), k: ["2026-01-01 00:00:00"], id: "a" })).toString("base64url");
      expect((await search({ category: cat.slug, sort: "newest", cursor: `${forged}.${forged}` })).status).toBe(400);
      expect((await search({ category: cat.slug, sort: "newest", cursor: forged })).status).toBe(400);
      expect((await search({ category: cat.slug, sort: "newest", limit: 1, cursor: p1.body.nextCursor })).status).toBe(200);
    });
  });

  describe("NUL characters", () => {
    it("rejects U+0000 in any query string with 400 VALIDATION_FAILED", async () => {
      for (const qs of ["q=%00", "q=a%00b", "category=%00", "category=a%00", "level=%00"]) {
        const res = await http().get(`/v1/courses?${qs}`).set("X-Forwarded-For", uniqueIp());
        expect([qs, res.status, res.body.error?.code]).toEqual([qs, 400, "VALIDATION_FAILED"]);
      }
      const pathRes = await http().get(`/v1/courses/${"a%00b"}`);
      expect(JSON.stringify([pathRes.status, pathRes.body])).toContain("[400");
    });

    it("rejects U+0000 anywhere in a JSON body, on any route", async () => {
      const s = await t.login();
      const authz = { Authorization: `Bearer ${s.accessToken}` };
      const nul = "a b";
      const cat = await category();
      const valid = { description: "d", categoryId: cat.id, language: "en" };
      await http().post("/v1/me/become-creator").set(authz).send({ acceptTerms: true });
      const post = (path: string, body: unknown, h: Record<string, string> = authz) => http().post(path).set(h).set("Content-Type", "application/json").send(JSON.stringify(body));
      for (const body of [{ ...valid, title: `Title ${nul}` }, { ...valid, title: "Fine title", tags: [nul] }, { ...valid, title: "Fine title", nested: { list: [{ deep: nul }] } }, { ...valid, title: "Fine title", [nul]: 1 }]) {
        const res = await post("/v1/studio/courses", body);
        expect([res.status, res.body.error?.code]).toEqual([400, "VALIDATION_FAILED"]);
      }
      const anon = await post("/v1/auth/otp/request", { email: `x${nul}@example.com` }, {});
      expect([anon.status, anon.body.error?.code]).toEqual([400, "VALIDATION_FAILED"]);
    });

    it("accepts a category slug only in slug form", async () => {
      for (const bad of ["Upper", "has space", "a_b", "x".repeat(61), "a/b"]) expect((await search({ category: bad })).status).toBe(400);
      expect((await search({ category: "development" })).status).toBe(200);
    });
  });

  describe("keeping the index current", () => {
    it("indexes a course when the studio creates it and when its text changes", async () => {
      const s = await t.login();
      expect((await http().post("/v1/me/become-creator").set({ Authorization: `Bearer ${s.accessToken}` }).send({ acceptTerms: true })).status).toBe(200);
      const cat = await category();
      const word = `zeno${uniq()}`;
      const created = await http().post("/v1/studio/courses").set({ Authorization: `Bearer ${s.accessToken}` }).send({ title: `Draft ${word}`, description: "d", categoryId: cat.id, language: "en" });
      expect(created.status).toBe(201);
      const row = await prisma.$queryRaw<Array<{ doc: string; owner: string }>>`SELECT "searchVector"::text AS doc, "ownerName" AS owner FROM "courses" WHERE "id" = ${created.body.id}`;
      expect(row[0].doc).toContain(word);
      expect(row[0].owner).not.toBe("");
      const word2 = `ptolemy${uniq()}`;
      expect((await http().patch(`/v1/studio/courses/${created.body.id}`).set({ Authorization: `Bearer ${s.accessToken}` }).send({ subtitle: `All about ${word2}` })).status).toBe(200);
      const after = await prisma.$queryRaw<Array<{ doc: string }>>`SELECT "searchVector"::text AS doc FROM "courses" WHERE "id" = ${created.body.id}`;
      expect(after[0].doc).toContain(word2);
    });

    it("re-indexes a creator's courses when they rename themselves; delivering the event twice changes nothing more", async () => {
      const s = await t.login();
      const profiles = t.app.get(ProfilesService);
      await profiles.ensure(s.userId);
      const cat = await category();
      const first = `Aldous${uniq()}`;
      await profiles.update(s.userId, { displayName: first });
      const mine = await course(cat.id, { title: "Owned", ownerType: "USER", ownerId: s.userId, ownerName: first });
      const second = `Bertram${uniq()}`;
      await profiles.update(s.userId, { displayName: second });
      const rows = await prisma.outboxEvent.findMany({ where: { type: "user.profile_updated", payload: { path: ["userId"], equals: s.userId } }, orderBy: { createdAt: "asc" } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const latest = rows[rows.length - 1];
      for (let i = 0; i < 2; i++) await bus.dispatch({ type: "user.profile_updated", ...(latest.payload as object) } as DomainEvent, latest.id);
      expect((await search({ q: second, category: cat.slug })).body.items.map((c: Card) => c.id)).toEqual([mine.id]);
      expect((await search({ q: first, category: cat.slug })).body.items).toEqual([]);
      expect((await prisma.course.findUniqueOrThrow({ where: { id: mine.id } })).ownerName).toBe(second);
      // A change that is not a rename emits no event.
      const before = await prisma.outboxEvent.count({ where: { type: "user.profile_updated", payload: { path: ["userId"], equals: s.userId } } });
      await profiles.update(s.userId, { headline: "Hello" });
      expect(await prisma.outboxEvent.count({ where: { type: "user.profile_updated", payload: { path: ["userId"], equals: s.userId } } })).toBe(before);
    });

    it("re-indexes an organization's courses when it is renamed", async () => {
      const s = await t.login();
      const orgs = t.app.get(OrganizationsService);
      const org = await orgs.create(s.userId, { name: `Acme ${uniq()}` });
      const cat = await category();
      const mine = await course(cat.id, { title: "Org course", ownerType: "ORG", ownerId: org.id, ownerName: org.name });
      const renamed = `Globex${uniq()}`;
      await orgs.update(s.userId, org.slug, { name: renamed });
      const row = await prisma.outboxEvent.findFirstOrThrow({ where: { type: "org.renamed", payload: { path: ["orgId"], equals: org.id } } });
      await bus.dispatch({ type: "org.renamed", ...(row.payload as object) } as DomainEvent, row.id);
      expect((await search({ q: renamed, category: cat.slug })).body.items.map((c: Card) => c.id)).toEqual([mine.id]);
    });
  });

  describe("popularity", () => {
    it("counts the active enrolments of the last 30 days in one pass, and puts the rest back to zero", async () => {
      const cat = await category();
      const day = 24 * 60 * 60 * 1000;
      const now = t.clock.now().getTime();
      const a = await course(cat.id, { title: "Hot", enrolments30d: 99 });
      const b = await course(cat.id, { title: "Warm" });
      const c = await course(cat.id, { title: "Cold", enrolments30d: 7 });
      const rows = (courseId: string, n: number, over: Record<string, unknown>) => Array.from({ length: n }, () => ({ courseId, userId: `u-${uniq()}`, source: "FREE" as const, ...over }));
      await prisma.enrolment.createMany({
        data: [
          ...rows(a.id, 3, { createdAt: new Date(now - day) }),
          ...rows(a.id, 2, { createdAt: new Date(now - 40 * day) }),
          ...rows(b.id, 1, { createdAt: new Date(now - 29 * day) }),
          ...rows(b.id, 1, { createdAt: new Date(now - day), revokedAt: new Date(now) }),
        ],
      });
      await t.app.get(CoursePopularity).refresh();
      const read = async (id: string) => (await prisma.course.findUniqueOrThrow({ where: { id } })).enrolments30d;
      expect([await read(a.id), await read(b.id), await read(c.id)]).toEqual([3, 1, 0]);
      expect(titles(await search({ category: cat.slug, sort: "popular" }))).toEqual(["Hot", "Warm", "Cold"]);
      expect(await t.app.get(CoursePopularity).refresh()).toBe(0); // nothing changed, nothing rewritten
    });
  });
});
