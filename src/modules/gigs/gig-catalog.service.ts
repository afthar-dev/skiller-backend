import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CourseCategories } from "../courses";
import { toGigCard } from "./gig-view";
import { GigVisibility } from "./gig-visibility";

export const GIG_SORTS = ["relevance", "newest", "price_asc", "price_desc"] as const;
export type GigSort = (typeof GIG_SORTS)[number];
/** How the text query matches: `fts` when the full-text query matches something, `trgm` (fuzzy title) when it does not, `none` without a text query. */
type Mode = "fts" | "trgm" | "none";
type KeyCast = "timestamp" | "bigint" | "numeric";

export interface GigCatalogQuery {
  q?: string;
  category?: string;
  minPrice?: bigint;
  maxPrice?: bigint;
  sort: GigSort;
  cursor?: string;
  limit: number;
}

const CURSOR_CONTEXT = "gig-catalog";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_SHAPES: Record<KeyCast, RegExp> = {
  timestamp: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/,
  bigint: /^\d{1,13}$/,
  numeric: /^\d{1,6}(\.\d{1,6})?$/,
};
/** Weight of the title similarity next to the text rank, and the word similarity a fuzzy title match needs. */
const TITLE_SIMILARITY_WEIGHT = 0.3;
const TRIGRAM_THRESHOLD = 0.4;
/** Rows are filtered for seller visibility after the query (suspended accounts, blocks); a page that comes up short is refilled this many times. */
const MAX_ROUNDS = 6;

interface Key {
  expr: Prisma.Sql;
  cast: KeyCast;
}
interface Plan {
  sort: GigSort;
  mode: Mode;
  hash: string;
  key: Key;
  asc: boolean;
  where: Prisma.Sql[];
  after: { k: string; id: string } | null;
}
interface Row {
  id: string;
  sellerId: string;
  k: string;
}

/** Postgres refused a value (class 22: out of range, bad datetime, ...). Only a hand-made cursor can cause it. */
function isDataException(err: unknown): boolean {
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  return typeof meta?.code === "string" && meta.code.startsWith("22");
}

/**
 * The public gig catalog: live gigs only, searched and filtered in the database (partial indexes on ACTIVE gigs), paged with a signed keyset cursor.
 * Whether the seller may be seen (account active, no block either way) cannot be asked in SQL without reading another module's tables, so the page is
 * filtered through GigVisibility and refilled from the same keyset until it is full or the matches run out.
 */
@Injectable()
export class GigCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: SignedCursor,
    private readonly categories: CourseCategories,
    private readonly visibility: GigVisibility,
  ) {}

  async search(query: GigCatalogQuery, viewerId: string | null) {
    const plan = await this.plan(query);
    if (!plan) return { items: [], nextCursor: null };
    const batch = query.limit * 2 + 1;
    const kept: Row[] = [];
    let after = plan.after;
    let more = false;
    let scanned: Row | undefined;
    for (let round = 0; round < MAX_ROUNDS && kept.length < query.limit; round++) {
      const rows = await this.run(plan, after, batch);
      const visible = await this.visibility.visibleSellers(viewerId, rows.map((r) => r.sellerId));
      more = rows.length === batch;
      for (let i = 0; i < rows.length; i++) {
        scanned = rows[i];
        if (visible.has(rows[i].sellerId)) kept.push(rows[i]);
        if (kept.length === query.limit) {
          more = i < rows.length - 1 || rows.length === batch;
          break;
        }
      }
      if (!more) break;
      after = { k: scanned!.k, id: scanned!.id };
    }
    const last = kept.length === query.limit ? kept[kept.length - 1] : scanned;
    const nextCursor = more && last ? this.cursors.sign(CURSOR_CONTEXT, { s: plan.sort, m: plan.mode, h: plan.hash, k0: last.k, id: last.id }) : null;
    const byId = new Map((await this.prisma.gig.findMany({ where: { id: { in: kept.map((r) => r.id) }, status: "ACTIVE" }, include: { packages: true } })).map((g) => [g.id, g]));
    return { items: kept.flatMap((r) => (byId.has(r.id) ? [toGigCard(byId.get(r.id)!)] : [])), nextCursor };
  }

  /** Decides the matching mode and the filters; null when the query can match nothing (an unknown category). */
  private async plan(query: GigCatalogQuery): Promise<Plan | null> {
    const q = query.q?.normalize("NFC").trim() || undefined;
    // Without a text query "relevance" has nothing to rank by: newest first.
    const sort: GigSort = query.sort === "relevance" && !q ? "newest" : query.sort;
    const hash = createHash("sha256")
      .update(JSON.stringify([q ?? "", query.category ?? "", query.minPrice?.toString() ?? "", query.maxPrice?.toString() ?? "", sort]))
      .digest("hex")
      .slice(0, 12);
    const payload = query.cursor ? this.cursors.verify(CURSOR_CONTEXT, query.cursor) : null;
    if (payload && (payload.s !== sort || payload.h !== hash || typeof payload.k0 !== "string" || typeof payload.id !== "string" || !UUID.test(payload.id))) throw badCursor();

    // publishedAt is set by every activation; the newest index relies on it.
    const filters: Prisma.Sql[] = [Prisma.sql`g."status" = 'ACTIVE'`, Prisma.sql`g."publishedAt" IS NOT NULL`];
    if (query.category) {
      const categoryId = await this.categories.idBySlug(query.category);
      if (!categoryId) return null;
      filters.push(Prisma.sql`g."categoryId" = ${categoryId}`);
    }
    if (query.minPrice !== undefined) filters.push(Prisma.sql`g."startingPricePaise" >= ${query.minPrice}`);
    if (query.maxPrice !== undefined) filters.push(Prisma.sql`g."startingPricePaise" <= ${query.maxPrice}`);

    let mode: Mode = "none";
    if (q) mode = payload ? (payload.m as Mode) : (await this.matchesFullText(filters, q)) ? "fts" : "trgm";
    // The mode is a function of the query: a cursor cannot choose it.
    if (payload && (q ? payload.m !== "fts" && payload.m !== "trgm" : payload.m !== "none")) throw badCursor();
    const where = [...filters];
    if (q) where.push(mode === "fts" ? Prisma.sql`g."searchVector" @@ ${this.tsquery(q)}` : Prisma.sql`${q}::text <% g."title"`);

    const key = this.key(sort, mode, q);
    if (payload && !KEY_SHAPES[key.cast].test(payload.k0 as string)) throw badCursor();
    return { sort, mode, hash, key, asc: sort === "price_asc", where, after: payload ? { k: payload.k0 as string, id: payload.id as string } : null };
  }

  private async run(plan: Plan, after: { k: string; id: string } | null, take: number): Promise<Row[]> {
    const conditions = [...plan.where];
    if (after) conditions.push(Prisma.sql`(${plan.key.expr}, g."id") ${Prisma.raw(plan.asc ? ">" : "<")} (${after.k}::${Prisma.raw(plan.key.cast)}, ${after.id}::text)`);
    const dir = Prisma.raw(plan.asc ? "ASC" : "DESC");
    const sql = Prisma.sql`
      SELECT g."id", g."sellerId", ${plan.key.expr}::text AS "k"
      FROM "gigs" g
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY ${plan.key.expr} ${dir}, g."id" ${dir}
      LIMIT ${take}`;
    try {
      if (plan.mode !== "trgm") return await this.prisma.$queryRaw<Row[]>(sql);
      // The operator `<%` compares against this setting; LOCAL keeps it inside the transaction.
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${TRIGRAM_THRESHOLD}`);
        return tx.$queryRaw<Row[]>(sql);
      });
    } catch (err) {
      if (isDataException(err)) throw badCursor();
      throw err;
    }
  }

  private key(sort: GigSort, mode: Mode, q: string | undefined): Key {
    switch (sort) {
      case "newest":
        return { expr: Prisma.sql`g."publishedAt"`, cast: "timestamp" };
      case "price_asc":
      case "price_desc":
        return { expr: Prisma.sql`g."startingPricePaise"`, cast: "bigint" };
      case "relevance": {
        const text = q as string;
        const score =
          mode === "fts"
            ? Prisma.sql`ts_rank(g."searchVector", ${this.tsquery(text)}) + ${TITLE_SIMILARITY_WEIGHT} * similarity(g."title", ${text}::text)`
            : Prisma.sql`greatest(similarity(g."title", ${text}::text), word_similarity(${text}::text, g."title"))`;
        // Rounded so the cursor can carry the exact value.
        return { expr: Prisma.sql`round((${score})::numeric, 6)`, cast: "numeric" };
      }
    }
  }

  private tsquery(q: string): Prisma.Sql {
    return Prisma.sql`websearch_to_tsquery('simple', ${q}::text)`;
  }

  private async matchesFullText(filters: Prisma.Sql[], q: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM "gigs" g WHERE ${Prisma.join([...filters, Prisma.sql`g."searchVector" @@ ${this.tsquery(q)}`], " AND ")}) AS "found"`;
    return rows[0]?.found === true;
  }
}
