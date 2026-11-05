import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { PageQuery } from "../../common/http/pagination";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ReelVisibility } from "./reel-visibility";
import { ReelViews, type ReelView } from "./reel-views";
import { collectVisible } from "./visible-page";

const SEARCH_CURSOR = "reel-search";
/** Longest search text kept, in characters; the rest is ignored. */
export const SEARCH_MAX_CHARS = 100;
/** Fuzzy caption matches (a typo, a half-typed word) need at least this word similarity (same as course search). */
export const TRIGRAM_THRESHOLD = 0.4;

type Mode = "fts" | "trgm";

/** Postgres refused a value (class 22). Only a hand-made cursor can cause it here. */
function isDataException(err: unknown): boolean {
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  return typeof meta?.code === "string" && meta.code.startsWith("22");
}

/** What a search sees of the text: NFC, control characters and runs of blanks folded to one space, trimmed, cut to SEARCH_MAX_CHARS characters. */
export function cleanSearchText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return Array.from(raw.normalize("NFC").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim()).slice(0, SEARCH_MAX_CHARS).join("").trim();
}

/**
 * Reel search over captions and hashtags. Full text first (the `simple` configuration: no stemming, no stop words, so it works in every
 * language; websearch syntax, which never fails on odd input); if nothing matches that way, a fuzzy match on the caption (trigram word
 * similarity) catches typos and half-typed words. Newest matches first, keyset-paged with a signed cursor bound to the text and the mode.
 */
@Injectable()
export class ReelSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: ReelViews,
    private readonly visibility: ReelVisibility,
    private readonly cursors: SignedCursor,
  ) {}

  async search(rawQuery: unknown, page: PageQuery, viewerId: string | null): Promise<{ items: ReelView[]; nextCursor: string | null }> {
    const q = cleanSearchText(rawQuery);
    if (!q) return { items: [], nextCursor: null };
    const hash = createHash("sha256").update(q).digest("hex").slice(0, 16);

    type Pos = { t: Date; id: string };
    let start: Pos | null = null;
    let mode: Mode;
    if (page.cursor) {
      const c = this.cursors.verify(SEARCH_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (c.h !== hash || (c.m !== "fts" && c.m !== "trgm") || typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      mode = c.m;
      start = { t, id: c.id };
    } else {
      mode = (await this.matchesFullText(q)) ? "fts" : "trgm";
    }

    try {
      const { items, next } = await collectVisible({
        limit: page.limit,
        start,
        fetch: (after: Pos | null, take) => this.page(q, mode, after, take),
        posOf: (r): Pos => ({ t: r.publishedAt, id: r.id }),
        idOf: (r) => r.id,
        visible: (ids) => this.visibility.filterVisible(viewerId, { reelIds: ids }),
      });
      const rows = new Map((await this.prisma.reel.findMany({ where: { id: { in: items.map((i) => i.id) }, status: "PUBLISHED" } })).map((r) => [r.id, r]));
      const ordered = items.flatMap((i) => (rows.has(i.id) ? [rows.get(i.id)!] : []));
      return { items: await this.views.build(ordered, viewerId), nextCursor: next ? this.cursors.sign(SEARCH_CURSOR, { h: hash, m: mode, t: next.t.toISOString(), id: next.id }) : null };
    } catch (err) {
      if (isDataException(err)) throw badCursor();
      throw err;
    }
  }

  private tsquery(q: string): Prisma.Sql {
    return Prisma.sql`websearch_to_tsquery('simple', ${q}::text)`;
  }

  private async matchesFullText(q: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM "reels" r WHERE r."status" = 'PUBLISHED'::"ReelStatus" AND r."searchVector" @@ ${this.tsquery(q)}) AS "found"`;
    return rows[0]?.found === true;
  }

  private async page(q: string, mode: Mode, after: { t: Date; id: string } | null, take: number): Promise<Array<{ id: string; publishedAt: Date }>> {
    const match = mode === "fts" ? Prisma.sql`r."searchVector" @@ ${this.tsquery(q)}` : Prisma.sql`${q}::text <% r."caption"`;
    const keyset = after ? Prisma.sql`AND (r."publishedAt" < ${after.t} OR (r."publishedAt" = ${after.t} AND r."id" < ${after.id}))` : Prisma.empty;
    const sql = Prisma.sql`
      SELECT r."id", r."publishedAt" FROM "reels" r
      WHERE r."status" = 'PUBLISHED'::"ReelStatus" AND ${match} ${keyset}
      ORDER BY r."publishedAt" DESC, r."id" DESC
      LIMIT ${take}`;
    if (mode === "fts") return this.prisma.$queryRaw<Array<{ id: string; publishedAt: Date }>>(sql);
    // The operator `<%` compares against this setting; LOCAL keeps it inside the transaction.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${TRIGRAM_THRESHOLD}`);
      return tx.$queryRaw<Array<{ id: string; publishedAt: Date }>>(sql);
    });
  }
}
