import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { badCursor, SignedCursor, type CursorPayload } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { extractHashtags } from "./hashtags";
import { ReelVisibility } from "./reel-visibility";
import { ReelViews, type ReelView } from "./reel-views";
import { collectVisible } from "./visible-page";

export const HASHTAG_SORTS = ["top", "recent"] as const;
export type HashtagSort = (typeof HASHTAG_SORTS)[number];

const RECENT_CURSOR = "hashtag-recent";
const TOP_CURSOR = "hashtag-top";

export const invalidHashtag = () => new AppError("HASHTAG_INVALID", 400, "A hashtag is 1 to 50 letters, digits or underscores");

/** A tag from a URL ("react", "#React", "%23REACT") the way it is stored: parsed with the very rules captions are parsed with. Null if it is not a single valid tag. */
export function normaliseHashtag(raw: string): string | null {
  const text = raw.trim().replace(/^#/, "").normalize("NFC");
  if (text.length === 0 || text.length > 200) return null;
  const tags = extractHashtags(`#${text}`);
  return tags.length === 1 && tags[0] === text.toLowerCase().normalize("NFC") ? tags[0] : null;
}

export interface HashtagReelsPage {
  tag: string;
  /** Published reels that carry the tag. */
  reelCount: number;
  items: ReelView[];
  nextCursor: string | null;
}

/**
 * A hashtag's page: `recent` is newest first, `top` is by engagement (likes + 2 comments + 3 saves + 2 shares), ties newest id first.
 * Both are keyset-paged with signed cursors bound to the tag and the sort. `top` ranks by live counters: a reel whose count moves between two
 * pages can be missed or seen twice at that boundary, which is the price of a list without a snapshot (the For you feed has one).
 */
@Injectable()
export class HashtagReelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: ReelViews,
    private readonly visibility: ReelVisibility,
    private readonly cursors: SignedCursor,
  ) {}

  async reels(rawTag: string, sort: HashtagSort, page: PageQuery, viewerId: string | null): Promise<HashtagReelsPage> {
    const tag = normaliseHashtag(rawTag);
    if (!tag) throw invalidHashtag();
    const [counter, listed] = await Promise.all([this.prisma.hashtag.findUnique({ where: { tag }, select: { reelCount: true } }), sort === "top" ? this.top(tag, page, viewerId) : this.recent(tag, page, viewerId)]);
    return { tag, reelCount: counter?.reelCount ?? 0, ...listed };
  }

  private async recent(tag: string, page: PageQuery, viewerId: string | null) {
    type Pos = { t: Date; id: string };
    let start: Pos | null = null;
    if (page.cursor) {
      const c = this.cursors.verify(RECENT_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (c.tag !== tag || typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      start = { t, id: c.id };
    }
    const { items, next } = await collectVisible({
      limit: page.limit,
      start,
      fetch: (after: Pos | null, take) =>
        this.prisma.reel.findMany({
          where: { hashtags: { has: tag }, status: "PUBLISHED", ...(after ? { OR: [{ publishedAt: { lt: after.t } }, { publishedAt: after.t, id: { lt: after.id } }] } : {}) },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          take,
        }),
      posOf: (r): Pos => ({ t: r.publishedAt!, id: r.id }),
      idOf: (r) => r.id,
      visible: (ids) => this.visibility.filterVisible(viewerId, { reelIds: ids }),
    });
    return { items: await this.views.build(items, viewerId), nextCursor: next ? this.cursors.sign(RECENT_CURSOR, { tag, t: next.t.toISOString(), id: next.id }) : null };
  }

  private async top(tag: string, page: PageQuery, viewerId: string | null) {
    type Pos = { sc: number; id: string };
    let start: Pos | null = null;
    if (page.cursor) {
      const c: CursorPayload = this.cursors.verify(TOP_CURSOR, page.cursor);
      if (c.tag !== tag || typeof c.id !== "string" || typeof c.sc !== "number" || !Number.isSafeInteger(c.sc)) throw badCursor();
      start = { sc: c.sc, id: c.id };
    }
    const { items, next } = await collectVisible({
      limit: page.limit,
      start,
      fetch: async (after: Pos | null, take) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; sc: bigint }>>`
          SELECT s."id", s."sc" FROM (
            SELECT r."id", (r."likeCount" + 2 * r."commentCount" + 3 * r."saveCount" + 2 * r."shareCount")::bigint AS "sc"
            FROM "reels" r
            WHERE r."status" = 'PUBLISHED'::"ReelStatus" AND r."hashtags" @> ARRAY[${tag}]::text[]
          ) s
          WHERE ${after ? Prisma.sql`(s."sc" < ${after.sc}::bigint OR (s."sc" = ${after.sc}::bigint AND s."id" < ${after.id}))` : Prisma.sql`TRUE`}
          ORDER BY s."sc" DESC, s."id" DESC
          LIMIT ${take}`;
        return rows.map((r) => ({ id: r.id, sc: Number(r.sc) }));
      },
      posOf: (r): Pos => ({ sc: r.sc, id: r.id }),
      idOf: (r) => r.id,
      visible: (ids) => this.visibility.filterVisible(viewerId, { reelIds: ids }),
    });
    const rows = new Map((await this.prisma.reel.findMany({ where: { id: { in: items.map((i) => i.id) }, status: "PUBLISHED" } })).map((r) => [r.id, r]));
    const ordered = items.flatMap((i) => (rows.has(i.id) ? [rows.get(i.id)!] : []));
    return { items: await this.views.build(ordered, viewerId), nextCursor: next ? this.cursors.sign(TOP_CURSOR, { tag, sc: next.sc, id: next.id }) : null };
  }
}
