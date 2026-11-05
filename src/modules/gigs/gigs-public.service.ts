import { Injectable } from "@nestjs/common";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import type { PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ProfilesService } from "../users";
import { gigNotFound } from "./gig-rules";
import { toGigCard, toPublicGigView } from "./gig-view";
import { GigVisibility } from "./gig-visibility";

const PROFILE_GIGS_CURSOR = "profile-gigs";

/** What the public sees of gigs: only live gigs of sellers the viewer may see (GigVisibility). Everything else is a plain 404 / empty list. */
@Injectable()
export class GigsPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly visibility: GigVisibility,
    private readonly cursors: SignedCursor,
  ) {}

  async page(slug: string, viewerId: string | null) {
    const gig = await this.prisma.gig.findUnique({ where: { slug }, include: { packages: true, gallery: true, faqs: true } });
    if (!gig || gig.status !== "ACTIVE" || !(await this.visibility.visibleSellers(viewerId, [gig.sellerId])).has(gig.sellerId)) throw gigNotFound();
    const seller = (await this.profiles.summaries([gig.sellerId])).get(gig.sellerId) ?? null;
    return toPublicGigView(gig, seller);
  }

  /** A seller's live gigs, newest first (by the time they first went live). */
  async byHandle(handle: string, page: PageQuery, viewerId: string | null) {
    const profile = await this.profiles.getByHandle(handle);
    if (!(await this.visibility.visibleSellers(viewerId, [profile.userId])).has(profile.userId)) return { items: [], nextCursor: null };
    let after: { t: Date; id: string } | undefined;
    if (page.cursor) {
      const c = this.cursors.verify(PROFILE_GIGS_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      after = { t, id: c.id };
    }
    const rows = await this.prisma.gig.findMany({
      where: { sellerId: profile.userId, status: "ACTIVE", ...(after ? { OR: [{ publishedAt: { lt: after.t } }, { publishedAt: after.t, id: { lt: after.id } }] } : {}) },
      include: { packages: true },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > page.limit && last?.publishedAt ? this.cursors.sign(PROFILE_GIGS_CURSOR, { t: last.publishedAt.toISOString(), id: last.id }) : null;
    return { items: items.map(toGigCard), nextCursor };
  }
}
