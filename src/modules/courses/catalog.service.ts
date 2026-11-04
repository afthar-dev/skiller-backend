import { Injectable } from "@nestjs/common";
import { Prisma, type CourseLevel } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { toCatalogCard } from "./course-view";
import { MIN_RATINGS_TO_SHOW } from "./course-rating";

export const CATALOG_SORTS = ["relevance", "newest", "rating", "popular"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** How the text query matches: `fts` when the full-text query matches something, `trgm` (fuzzy title) when it does not, `none` without a text query. */
type Mode = "fts" | "trgm" | "none";

export interface CatalogQuery {
  q?: string;
  category?: string;
  level?: CourseLevel;
  language?: string;
  price?: "free" | "paid";
  minPrice?: bigint;
  maxPrice?: bigint;
  minRating?: number;
  sort: CatalogSort;
  cursor?: string;
  limit: number;
}

/** Weight of the title similarity next to the text rank. */
export const TITLE_SIMILARITY_WEIGHT = 0.3;
/** Fuzzy title matches (a typo, a half-typed word) need at least this word similarity. */
export const TRIGRAM_THRESHOLD = 0.4;

const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const INT = /^\d{1,10}$/;
const NUM = /^\d{1,6}(\.\d{1,6})?$/;

interface Key {
  expr: Prisma.Sql;
  cast: "timestamp" | "int" | "numeric";
  valid: RegExp;
}

const cursorSchema = z
  .object({ v: z.literal(1), s: z.enum(CATALOG_SORTS), m: z.enum(["fts", "trgm", "none"]), h: z.string().length(12), k: z.array(z.string().max(40)).min(1).max(2), id: z.string().min(1).max(64) })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

const badCursor = () => new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { cursor: ["invalid"] } });

/** The query that finds the page: ids and the sort keys of each row (as text, for the next cursor). Exposed so the plan can be checked. */
export interface SearchPlan {
  mode: Mode;
  sort: CatalogSort;
  sql: Prisma.Sql;
  keys: Key[];
  hash: string;
}

/** The public catalog: published, unflagged courses only, searched and filtered in the database, paged with a keyset cursor. */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: CatalogQuery) {
    const plan = await this.plan(query);
    const rows = await this.run(plan);
    const page = rows.slice(0, query.limit);
    const byId = new Map((await this.prisma.course.findMany({ where: { id: { in: page.map((r) => r.id) } } })).map((c) => [c.id, c]));
    const items = page.flatMap((r) => (byId.has(r.id) ? [toCatalogCard(byId.get(r.id)!)] : []));
    const last = page[page.length - 1];
    const nextCursor = rows.length > query.limit && last ? this.encode(plan, last) : null;
    return { items, nextCursor };
  }

  /** Decides the matching mode and builds the page query. */
  async plan(query: CatalogQuery): Promise<SearchPlan> {
    const q = query.q?.trim() || undefined;
    // Without a text query "relevance" has nothing to rank by: show what is popular.
    const sort: CatalogSort = query.sort === "relevance" && !q ? "popular" : query.sort;
    const hash = this.hashOf(query, q, sort);
    const after = query.cursor ? this.decode(query.cursor, sort, hash) : null;

    const filters = this.filters(query);
    let mode: Mode = "none";
    if (q) mode = after ? after.m : (await this.matchesFullText(filters, q)) ? "fts" : "trgm";
    if (!q && after && after.m !== "none") throw badCursor();

    const where = [...filters];
    if (q) where.push(mode === "fts" ? Prisma.sql`c."searchVector" @@ ${this.tsquery(q)}` : Prisma.sql`${q}::text <% c."title"`);
    const keys = this.keys(sort, mode, q);
    if (after && after.k.length !== keys.length) throw badCursor();
    if (after && after.k.some((v, i) => !keys[i].valid.test(v))) throw badCursor();
    return { mode, sort, hash, keys, sql: this.pageSql(where, keys, after, query.limit + 1) };
  }

  private async run(plan: SearchPlan): Promise<Array<{ id: string; k: string[] }>> {
    const read = (rows: Array<Record<string, string>>) => rows.map((r) => ({ id: r.id, k: plan.keys.map((_, i) => r[`k${i}`]) }));
    if (plan.mode !== "trgm") return read(await this.prisma.$queryRaw<Array<Record<string, string>>>(plan.sql));
    // The operator `<%` compares against this setting; LOCAL keeps it inside the transaction.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${TRIGRAM_THRESHOLD}`);
      return read(await tx.$queryRaw<Array<Record<string, string>>>(plan.sql));
    });
  }

  private filters(query: CatalogQuery): Prisma.Sql[] {
    const f: Prisma.Sql[] = [Prisma.sql`c."status" = 'PUBLISHED'`, Prisma.sql`c."flaggedAt" IS NULL`];
    if (query.category) f.push(Prisma.sql`c."categoryId" IN (SELECT "id" FROM "categories" WHERE "slug" = ${query.category})`);
    if (query.level) f.push(Prisma.sql`c."level" = ${query.level}::"CourseLevel"`);
    if (query.language) f.push(Prisma.sql`c."language" = ${query.language}`);
    if (query.price === "free") f.push(Prisma.sql`c."pricePaise" = 0`);
    if (query.price === "paid") f.push(Prisma.sql`c."pricePaise" > 0`);
    if (query.minPrice !== undefined) f.push(Prisma.sql`c."pricePaise" >= ${query.minPrice}`);
    if (query.maxPrice !== undefined) f.push(Prisma.sql`c."pricePaise" <= ${query.maxPrice}`);
    // A course whose rating is not shown yet (fewer than 3 ratings) has no rating to filter on.
    if (query.minRating !== undefined) f.push(Prisma.sql`c."ratingCount" >= ${MIN_RATINGS_TO_SHOW} AND c."ratingAvg" >= ${query.minRating}::numeric`);
    return f;
  }

  private tsquery(q: string): Prisma.Sql {
    return Prisma.sql`websearch_to_tsquery('simple', ${q}::text)`;
  }

  private async matchesFullText(filters: Prisma.Sql[], q: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM "courses" c WHERE ${Prisma.join([...filters, Prisma.sql`c."searchVector" @@ ${this.tsquery(q)}`], " AND ")}) AS "found"`;
    return rows[0]?.found === true;
  }

  /** The sort keys, most significant first; every sort ends with the id, so no two rows tie. All of them sort descending. */
  private keys(sort: CatalogSort, mode: Mode, q: string | undefined): Key[] {
    switch (sort) {
      case "newest":
        return [{ expr: Prisma.sql`coalesce(c."publishedAt", c."createdAt")`, cast: "timestamp", valid: TS }];
      case "popular":
        return [
          { expr: Prisma.sql`c."enrolments30d"`, cast: "int", valid: INT },
          { expr: Prisma.sql`c."enrolmentCount"`, cast: "int", valid: INT },
        ];
      case "rating":
        return [
          { expr: Prisma.sql`coalesce(CASE WHEN c."ratingCount" >= ${MIN_RATINGS_TO_SHOW} THEN c."ratingAvg" END, 0)`, cast: "numeric", valid: NUM },
          { expr: Prisma.sql`c."ratingCount"`, cast: "int", valid: INT },
        ];
      case "relevance": {
        const text = q as string;
        const score =
          mode === "fts"
            ? Prisma.sql`ts_rank(c."searchVector", ${this.tsquery(text)}) + ${TITLE_SIMILARITY_WEIGHT} * similarity(c."title", ${text}::text)`
            : Prisma.sql`greatest(similarity(c."title", ${text}::text), word_similarity(${text}::text, c."title"))`;
        // Rounded so the cursor can carry the exact value.
        return [{ expr: Prisma.sql`round((${score})::numeric, 6)`, cast: "numeric", valid: NUM }];
      }
    }
  }

  private pageSql(where: Prisma.Sql[], keys: Key[], after: Cursor | null, take: number): Prisma.Sql {
    const names = keys.map((_, i) => Prisma.raw(`"k${i}"`));
    const inner = Prisma.sql`SELECT c."id", ${Prisma.join(keys.map((k, i) => Prisma.sql`${k.expr} AS ${names[i]}`), ", ")} FROM "courses" c WHERE ${Prisma.join(where, " AND ")}`;
    const columns = Prisma.join([...names.map((n) => Prisma.sql`t.${n}`), Prisma.sql`t."id"`], ", ");
    const values = after ? Prisma.join([...keys.map((k, i) => Prisma.sql`${after.k[i]}::${Prisma.raw(k.cast)}`), Prisma.sql`${after.id}::text`], ", ") : null;
    const order = Prisma.join([...names.map((n) => Prisma.sql`t.${n} DESC`), Prisma.sql`t."id" DESC`], ", ");
    return Prisma.sql`
      SELECT t."id", ${Prisma.join(names.map((n) => Prisma.sql`t.${n}::text AS ${n}`), ", ")}
      FROM (${inner}) t
      ${values ? Prisma.sql`WHERE (${columns}) < (${values})` : Prisma.empty}
      ORDER BY ${order}
      LIMIT ${take}`;
  }

  private hashOf(query: CatalogQuery, q: string | undefined, sort: CatalogSort): string {
    const parts = [q ?? "", query.category ?? "", query.level ?? "", query.language ?? "", query.price ?? "", query.minPrice?.toString() ?? "", query.maxPrice?.toString() ?? "", query.minRating?.toString() ?? "", sort];
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
  }

  private encode(plan: SearchPlan, last: { id: string; k: string[] }): string {
    const cursor: Cursor = { v: 1, s: plan.sort, m: plan.mode, h: plan.hash, k: last.k, id: last.id };
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
  }

  /** A cursor is only good for the query that produced it: same filters, text and sort. */
  private decode(raw: string, sort: CatalogSort, hash: string): Cursor {
    let parsed: Cursor;
    try {
      parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    } catch {
      throw badCursor();
    }
    if (parsed.s !== sort || parsed.h !== hash) throw badCursor();
    return parsed;
  }
}
