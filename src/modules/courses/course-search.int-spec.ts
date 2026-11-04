import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { applyTestEnv } from "../../../test/setup/env";
import { ConfigModule } from "../../common/config/config.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CatalogCursor } from "./catalog-cursor";
import { CatalogService, type CatalogQuery } from "./catalog.service";
import { refreshCourseSearch } from "./course-search";

const SEEDED = 2000;

/** Walks an EXPLAIN (FORMAT JSON) tree and lists every node as "Node Type|Relation Name|Index Name". */
function nodes(plan: unknown): string[] {
  const out: string[] = [];
  const visit = (n: Record<string, unknown>) => {
    out.push(`${n["Node Type"]}|${n["Relation Name"] ?? ""}|${n["Index Name"] ?? ""}`);
    for (const child of (n["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) visit(child);
  };
  visit((plan as Array<{ Plan: Record<string, unknown> }>)[0].Plan);
  return out;
}

describe("catalog search plan", () => {
  let prisma: PrismaService;
  let catalog: CatalogService;
  let close: () => Promise<void>;
  const run = randomUUID().slice(0, 8);
  const rare = `xylophone${run}`;

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const mod = await Test.createTestingModule({ imports: [ConfigModule, PrismaModule], providers: [CatalogCursor, CatalogService] }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    catalog = mod.get(CatalogService);
    close = () => mod.close();

    const category = await prisma.category.create({ data: { slug: `plan-${run}`, name: `Plan ${run}` } });
    await prisma.$executeRaw`
      INSERT INTO "courses" ("id", "ownerType", "ownerId", "slug", "title", "subtitle", "description", "categoryId", "level", "language", "tags", "pricePaise", "status", "publishedAt", "createdById", "updatedAt", "ownerName")
      SELECT gen_random_uuid()::text, 'USER', 'plan-owner', ${`plan-${run}-`} || g, 'Course ' || g || ' on topic' || (g % 50) || ' module' || (g % 300), 'Subtitle ' || (g % 20), 'A description with words ' || repeat(md5(g::text) || ' ', 50), ${category.id}, 'ALL', 'en', ARRAY['tag' || (g % 30)], 0, 'PUBLISHED', now() - (g || ' minutes')::interval, 'plan-creator', now(), 'Owner ' || (g % 40)
      FROM generate_series(1, ${SEEDED}) g`;
    // Spread the sort keys so the indexes have something to order.
    await prisma.$executeRaw`UPDATE "courses" SET "enrolments30d" = abs(hashtext("slug")) % 17, "enrolmentCount" = abs(hashtext("id")) % 500, "ratingCount" = abs(hashtext("slug" || 'r')) % 9, "ratingAvg" = 3 + (abs(hashtext("slug" || 'a')) % 200) / 100.0 WHERE "slug" LIKE ${`plan-${run}-%`}`;
    // A handful of rows carry the rare word.
    await prisma.$executeRaw`UPDATE "courses" SET "title" = "title" || ${` ${rare}`} WHERE "slug" IN (${`plan-${run}-7`}, ${`plan-${run}-77`}, ${`plan-${run}-777`})`;
    const ids = await prisma.course.findMany({ where: { slug: { startsWith: `plan-${run}-` } }, select: { id: true } });
    for (let i = 0; i < ids.length; i += 100) await Promise.all(ids.slice(i, i + 100).map((c) => refreshCourseSearch(prisma, c.id)));
    // VACUUM also flushes the GIN pending list the 2,000 updates left behind (autovacuum does the same in production).
    await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "courses"`);
  }, 120_000);

  afterAll(async () => {
    await prisma?.course.deleteMany({ where: { slug: { startsWith: `plan-${run}-` } } });
    await prisma?.category.deleteMany({ where: { slug: `plan-${run}` } });
    await close?.();
  });

  const explainQuery = async (query: CatalogQuery) => {
    const plan = await catalog.plan(query);
    const rows = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${plan.sql}`);
    return { plan, tree: nodes(rows[0]["QUERY PLAN"]) };
  };
  const explain = (q: string, sort: "relevance" | "newest" | "popular" | "rating" = "relevance") => explainQuery({ q, sort, limit: 20 });
  const noSeqScan = (tree: string[]) => expect(tree.filter((n) => n.startsWith("Seq Scan|courses"))).toEqual([]);

  it("finds the rare word through the GIN index on the search document, never a sequential scan of courses", async () => {
    const { plan, tree } = await explain(rare);
    expect(plan.mode).toBe("fts");
    expect(tree.some((n) => n.endsWith("|courses_search_vector_idx"))).toBe(true);
    expect(tree.filter((n) => n.startsWith("Seq Scan|courses"))).toEqual([]);
  });

  it("uses the same index for the other sorts", async () => {
    for (const sort of ["newest", "popular", "rating"] as const) {
      const { tree } = await explain(rare, sort);
      expect(tree.some((n) => n.endsWith("|courses_search_vector_idx"))).toBe(true);
      expect(tree.filter((n) => n.startsWith("Seq Scan|courses"))).toEqual([]);
    }
  });

  it("returns exactly the three rows", async () => {
    const res = await catalog.search({ q: rare, sort: "relevance", limit: 20 });
    expect(res.items).toHaveLength(3);
    expect(res.nextCursor).toBeNull();
  });

  describe("browsing without a text query", () => {
    const category = () => ({ category: `plan-${run}` });

    it("reads every sort through its partial index, whatever the page depth", async () => {
      for (const [sort, index] of [["popular", "courses_pub_popular_idx"], ["newest", "courses_pub_newest_idx"], ["rating", "courses_pub_rating_idx"]] as const) {
        const { tree } = await explainQuery({ sort, limit: 20 });
        expect([sort, tree.some((n) => n.endsWith(`|${index}`))]).toEqual([sort, true]);
        noSeqScan(tree);
      }
    });

    it("keeps a deep page an index range scan: the cursor sits in the same SELECT as the ORDER BY", async () => {
      for (const sort of ["popular", "newest", "rating"] as const) {
        // Walk to a deep page the way a client does.
        let cursor: string | undefined;
        for (let i = 0; i < 40; i++) {
          const page = await catalog.search({ sort, limit: 20, cursor });
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        expect(cursor).toBeDefined();
        const { tree } = await explainQuery({ sort, limit: 20, cursor });
        noSeqScan(tree);
        expect(tree.some((n) => /^(Index Scan|Index Only Scan|Bitmap Index Scan)|/.test(n))).toBe(true);
        expect(tree.filter((n) => n.startsWith("Sort|"))).toEqual([]);
      }
    });

    it("pages through a seeded sort without repeats or gaps", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 200; i++) {
        const page = await catalog.search({ ...category(), sort: "popular", limit: 100, cursor });
        seen.push(...page.items.map((c) => c.id));
        cursor = page.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(SEEDED);
      expect(new Set(seen).size).toBe(SEEDED);
    });
  });
});
