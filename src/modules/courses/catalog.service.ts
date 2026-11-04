import { Injectable } from "@nestjs/common";
import { Prisma, type CourseLevel } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../common/prisma/prisma.service";
import { badCursor, CatalogCursor, validKey, CATALOG_SORTS, type CatalogMode, type CatalogSort, type CursorPayload, type KeyCast } from "./catalog-cursor";
import { MIN_RATINGS_TO_SHOW } from "./course-rating";
import { toCatalogCard } from "./course-view";

export { CATALOG_SORTS };
export type { CatalogSort };

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

interface Key {
  expr: Prisma.Sql;
  cast: KeyCast;
}

/** The query that finds the page: ids and the sort keys of each row (as text, for the next cursor). Exposed so the plan can be checked. */
export interface SearchPlan {
  mode: CatalogMode;
  sort: CatalogSort;
  sql: Prisma.Sql;
  keys: Key[];
  hash: string;
}

/** Postgres refused a value (class 22: out of range, bad datetime, bad text representation, ...). Only a hand-made cursor or text can cause it. */
function isDataException(err: unknown): boolean {
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  return typeof meta?.code === "string" && meta.code.startsWith("22");
}

/**
 * The public catalog: published, unflagged courses only, searched and filtered in the database, paged with a signed keyset cursor.
 * Sort keys are plain indexed columns (the partial indexes `courses_pub_*_idx`), the keyset predicate sits in the same SELECT as the ORDER BY,
 * so a page of any depth is an index range scan; only the text-relevance score is computed, and only for rows the text query already matched.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CatalogCursor,
  ) {}

  async search(query: CatalogQuery) {
    const plan = await this.plan(query);
    const rows = await this.run(plan);
    const page = rows.slice(0, query.limit);
    const byId = new Map((await this.prisma.course.findMany({ where: { id: { in: page.map((r) => r.id) } } })).map((c) => [c.id, c]));
    const items = page.flatMap((r) => (byId.has(r.id) ? [toCatalogCard(byId.get(r.id)!)] : []));
    const last = page[page.length - 1];
    const nextCursor = rows.length > query.limit && last ? this.cursors.sign({ v: 1, s: plan.sort, m: plan.mode, h: plan.hash, k: last.k, id: last.id }) : null;
    return { items, nextCursor };
  }

  /** Decides the matching mode and builds the page query. */
  async plan(query: CatalogQuery): Promise<SearchPlan> {
    const q = query.q?.normalize("NFC").trim() || undefined;
    // Without a text query "relevance" has nothing to rank by: show what is popular.
    const sort: CatalogSort = query.sort === "relevance" && !q ? "popular" : query.sort;
    const hash = this.hashOf(query, q, sort);
    const after = query.cursor ? this.cursors.verify(query.cursor) : null;
    if (after && (after.s !== sort || after.h !== hash)) throw badCursor();

    const filters = this.filters(query);
    let mode: CatalogMode = "none";
    if (q) mode = after ? after.m : (await this.matchesFullText(filters, q)) ? "fts" : "trgm";
    // The mode is a function of the query: a cursor cannot choose it.
    if (after && (q ? after.m === "none" : after.m !== "none")) throw badCursor();

    const where = [...filters];
    if (q) where.push(mode === "fts" ? Prisma.sql`c."searchVector" @@ ${this.tsquery(q)}` : Prisma.sql`${q}::text <% c."title"`);
    const keys = this.keys(sort, mode, q);
    if (after && (after.k.length !== keys.length || after.k.some((v, i) => !validKey(v, keys[i].cast)))) throw badCursor();
    return { mode, sort, hash, keys, sql: this.pageSql(where, keys, after, query.limit + 1) };
  }

  private async run(plan: SearchPlan): Promise<Array<{ id: string; k: string[] }>> {
    const read = (rows: Array<Record<string, string>>) => rows.map((r) => ({ id: r.id, k: plan.keys.map((_, i) => r[`k${i}`]) }));
    try {
      if (plan.mode !== "trgm") return read(await this.prisma.$queryRaw<Array<Record<string, string>>>(plan.sql));
      // The operator `<%` compares against this setting; LOCAL keeps it inside the transaction.
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${TRIGRAM_THRESHOLD}`);
        return read(await tx.$queryRaw<Array<Record<string, string>>>(plan.sql));
      });
    } catch (err) {
      if (isDataException(err)) throw badCursor();
      throw err;
    }
  }

  private filters(query: CatalogQuery): Prisma.Sql[] {
    // publishedAt is set by every publish; the catalog (and its newest index) relies on it.
    const f: Prisma.Sql[] = [Prisma.sql`c."status" = 'PUBLISHED'`, Prisma.sql`c."flaggedAt" IS NULL`, Prisma.sql`c."publishedAt" IS NOT NULL`];
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
  private keys(sort: CatalogSort, mode: CatalogMode, q: string | undefined): Key[] {
    switch (sort) {
      case "newest":
        return [{ expr: Prisma.sql`c."publishedAt"`, cast: "timestamp" }];
      case "popular":
        return [
          { expr: Prisma.sql`c."enrolments30d"`, cast: "int" },
          { expr: Prisma.sql`c."enrolmentCount"`, cast: "int" },
        ];
      case "rating":
        // ratingShown is the rating as the public sees it: 0 until MIN_RATINGS_TO_SHOW learners rated (a stored generated column).
        return [
          { expr: Prisma.sql`c."ratingShown"`, cast: "numeric" },
          { expr: Prisma.sql`c."ratingCount"`, cast: "int" },
        ];
      case "relevance": {
        const text = q as string;
        const score =
          mode === "fts"
            ? Prisma.sql`ts_rank(c."searchVector", ${this.tsquery(text)}) + ${TITLE_SIMILARITY_WEIGHT} * similarity(c."title", ${text}::text)`
            : Prisma.sql`greatest(similarity(c."title", ${text}::text), word_similarity(${text}::text, c."title"))`;
        // Rounded so the cursor can carry the exact value.
        return [{ expr: Prisma.sql`round((${score})::numeric, 6)`, cast: "numeric" }];
      }
    }
  }

  private pageSql(where: Prisma.Sql[], keys: Key[], after: CursorPayload | null, take: number): Prisma.Sql {
    const conditions = [...where];
    if (after) {
      const columns = Prisma.join([...keys.map((k) => k.expr), Prisma.sql`c."id"`], ", ");
      const values = Prisma.join([...keys.map((k, i) => Prisma.sql`${after.k[i]}::${Prisma.raw(k.cast)}`), Prisma.sql`${after.id}::text`], ", ");
      conditions.push(Prisma.sql`(${columns}) < (${values})`);
    }
    const selected = Prisma.join(keys.map((k, i) => Prisma.sql`${k.expr}::text AS ${Prisma.raw(`"k${i}"`)}`), ", ");
    const order = Prisma.join([...keys.map((k) => Prisma.sql`${k.expr} DESC`), Prisma.sql`c."id" DESC`], ", ");
    return Prisma.sql`
      SELECT c."id", ${selected}
      FROM "courses" c
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY ${order}
      LIMIT ${take}`;
  }

  private hashOf(query: CatalogQuery, q: string | undefined, sort: CatalogSort): string {
    const parts = [q ?? "", query.category ?? "", query.level ?? "", query.language ?? "", query.price ?? "", query.minPrice?.toString() ?? "", query.maxPrice?.toString() ?? "", query.minRating?.toString() ?? "", sort];
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
  }
}
