import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { GigVisibility } from "./gig-visibility";

export interface GigCard {
  id: string;
  slug: string;
  title: string;
}

export interface LiveGigCard extends GigCard {
  startingPricePaise: string | null;
  coverAssetId: string | null;
}

/** Read-only questions other modules (messaging today; reel link cards later) ask about gigs without touching gig tables. */
@Injectable()
export class GigLookup {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: GigVisibility,
  ) {}

  /** The gig is live (ACTIVE) and belongs to `sellerId`. Whether the seller's account may be seen or written to is the caller's concern. */
  async liveGigOf(gigId: string, sellerId: string): Promise<boolean> {
    return (await this.prisma.gig.count({ where: { id: gigId, sellerId, status: "ACTIVE" } })) > 0;
  }

  /**
   * Cards, for `viewerId`, of the gigs among `gigIds` they may be shown: the gig is live (ACTIVE) and its seller is an active account the viewer has no block with
   * (GigVisibility, the same rule as search and the gig page). Paused, held-back, removed and deleted gigs, suspended sellers and blocked pairs are absent, so a
   * conversation that mentions such a gig simply has no card (the gig id stays an opaque reference).
   */
  async visibleCards(viewerId: string, gigIds: string[]): Promise<Map<string, GigCard>> {
    if (gigIds.length === 0) return new Map();
    const rows = await this.prisma.gig.findMany({ where: { id: { in: gigIds }, status: "ACTIVE" }, select: { id: true, slug: true, title: true, sellerId: true } });
    const visible = await this.visibility.visibleSellers(viewerId, rows.map((g) => g.sellerId));
    return new Map(rows.filter((g) => visible.has(g.sellerId)).map((g) => [g.id, { id: g.id, slug: g.slug, title: g.title }]));
  }

  /**
   * Cards of the gigs among `gigIds` that are live (ACTIVE) right now; paused, held-back, removed and deleted gigs are absent. Whether the seller's account may be
   * seen is the caller's concern (a reel's creator is the seller, and the reel is already hidden with the creator).
   */
  async liveCards(gigIds: string[]): Promise<Map<string, LiveGigCard>> {
    if (gigIds.length === 0) return new Map();
    const rows = await this.prisma.gig.findMany({ where: { id: { in: gigIds }, status: "ACTIVE" }, select: { id: true, slug: true, title: true, startingPricePaise: true, coverAssetId: true } });
    return new Map(rows.map((g) => [g.id, { ...g, startingPricePaise: g.startingPricePaise === null ? null : g.startingPricePaise.toString() }]));
  }
}
