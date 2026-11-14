import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SITEMAP_PAGE_SIZE, type SitemapKind } from "./sitemap-rules";

interface Row {
  slug: string;
  updatedAt: Date;
}

/**
 * What a search engine may be told exists, one kind at a time, ordered by slug and keyset-paged with a signed cursor bound to the kind.
 * Every rule below restates the one the module's public read applies, so the sitemap never lists a URL that would 404 (or leak one):
 *  - courses: PUBLISHED, not flagged, publishedAt set (CatalogService filters, CoursesService.publicPage).
 *  - gigs: ACTIVE, and the seller's account is ACTIVE (GigsPublicService.page, GigVisibility).
 *  - profiles: the account is ACTIVE (ProfilesService.getByHandle) and the page has something to show: a public course, live gig or published
 *    reel, or a display name the person chose (not the one made from the email address, ProfilesService.isDefaultDisplayName).
 *  - categories: active, with at least one public course; updatedAt is the latest update of those courses.
 *  - hashtags: at least one PUBLISHED reel of an ACTIVE creator carries the tag (ReelVisibility); updatedAt is the tag's last use.
 */
@Injectable()
export class PublicSitemapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: SignedCursor,
  ) {}

  async page(kind: SitemapKind, cursor: string | undefined) {
    const after = this.after(kind, cursor);
    const rows = await this.query(kind, after);
    const items = rows.slice(0, SITEMAP_PAGE_SIZE).map((r) => ({ slug: r.slug, updatedAt: r.updatedAt.toISOString() }));
    const last = items[items.length - 1];
    const nextCursor = rows.length > SITEMAP_PAGE_SIZE && last ? this.cursors.sign(this.context(kind), { slug: last.slug }) : null;
    return { items, nextCursor };
  }

  private context = (kind: SitemapKind) => `sitemap:${kind}`;

  private after(kind: SitemapKind, cursor: string | undefined): string | null {
    if (!cursor) return null;
    const payload = this.cursors.verify(this.context(kind), cursor);
    if (typeof payload.slug !== "string") throw badCursor();
    return payload.slug;
  }

  private query(kind: SitemapKind, after: string | null): Promise<Row[]> {
    const take = SITEMAP_PAGE_SIZE + 1;
    switch (kind) {
      case "courses": {
        const keyset = after === null ? Prisma.empty : Prisma.sql`AND c."slug" > ${after}`;
        return this.prisma.$queryRaw<Row[]>`
          SELECT c."slug", c."updatedAt" FROM "courses" c
          WHERE c."status" = 'PUBLISHED' AND c."flaggedAt" IS NULL AND c."publishedAt" IS NOT NULL ${keyset}
          ORDER BY c."slug" LIMIT ${take}`;
      }
      case "gigs": {
        const keyset = after === null ? Prisma.empty : Prisma.sql`AND g."slug" > ${after}`;
        return this.prisma.$queryRaw<Row[]>`
          SELECT g."slug", g."updatedAt" FROM "gigs" g
          JOIN "users" u ON u."id" = g."sellerId" AND u."status" = 'ACTIVE'
          WHERE g."status" = 'ACTIVE' ${keyset}
          ORDER BY g."slug" LIMIT ${take}`;
      }
      case "profiles": {
        const keyset = after === null ? Prisma.empty : Prisma.sql`AND p."handle" > ${after}`;
        return this.prisma.$queryRaw<Row[]>`
          SELECT p."handle" AS "slug", p."updatedAt" FROM "profiles" p
          JOIN "users" u ON u."id" = p."userId" AND u."status" = 'ACTIVE'
          -- The first line mirrors ProfilesService.defaultDisplayName in SQL: BTRIM / LEFT(.., 80) against JS trim() / slice(0, 80). They differ only for exotic
          -- whitespace and for emoji (UTF-16 units vs characters), which an e-mail local part does not contain. Change both together.
          WHERE (
            p."displayName" <> LEFT(COALESCE(NULLIF(BTRIM(SPLIT_PART(u."email", '@', 1)), ''), 'Skiller user'), 80)
            OR EXISTS (SELECT 1 FROM "courses" c WHERE c."ownerType" = 'USER' AND c."ownerId" = p."userId" AND c."status" = 'PUBLISHED' AND c."flaggedAt" IS NULL AND c."publishedAt" IS NOT NULL)
            OR EXISTS (SELECT 1 FROM "gigs" g WHERE g."sellerId" = p."userId" AND g."status" = 'ACTIVE')
            OR EXISTS (SELECT 1 FROM "reels" r WHERE r."creatorId" = p."userId" AND r."status" = 'PUBLISHED')
          ) ${keyset}
          ORDER BY p."handle" LIMIT ${take}`;
      }
      case "categories": {
        const keyset = after === null ? Prisma.empty : Prisma.sql`AND k."slug" > ${after}`;
        return this.prisma.$queryRaw<Row[]>`
          SELECT k."slug", MAX(c."updatedAt") AS "updatedAt" FROM "categories" k
          JOIN "courses" c ON c."categoryId" = k."id" AND c."status" = 'PUBLISHED' AND c."flaggedAt" IS NULL AND c."publishedAt" IS NOT NULL
          WHERE k."isActive" ${keyset}
          GROUP BY k."slug" ORDER BY k."slug" LIMIT ${take}`;
      }
      case "hashtags": {
        const keyset = after === null ? Prisma.empty : Prisma.sql`AND h."tag" > ${after}`;
        return this.prisma.$queryRaw<Row[]>`
          SELECT h."tag" AS "slug", h."lastUsedAt" AS "updatedAt" FROM "hashtags" h
          WHERE EXISTS (
            SELECT 1 FROM "reels" r JOIN "users" u ON u."id" = r."creatorId" AND u."status" = 'ACTIVE'
            WHERE r."status" = 'PUBLISHED' AND r."hashtags" @> ARRAY[h."tag"]::text[]
          ) ${keyset}
          ORDER BY h."tag" LIMIT ${take}`;
      }
    }
  }
}
