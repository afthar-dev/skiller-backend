import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

  /** The gig is live (ACTIVE) and belongs to `sellerId`. Whether the seller's account may be seen or written to is the caller's concern. */
  async liveGigOf(gigId: string, sellerId: string): Promise<boolean> {
    return (await this.prisma.gig.count({ where: { id: gigId, sellerId, status: "ACTIVE" } })) > 0;
  }

  /** Cards of the gigs among `gigIds` that still exist for a conversation about them (live or paused); the others are absent. */
  async cards(gigIds: string[]): Promise<Map<string, GigCard>> {
    if (gigIds.length === 0) return new Map();
    const rows = await this.prisma.gig.findMany({ where: { id: { in: gigIds }, status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, slug: true, title: true } });
    return new Map(rows.map((g) => [g.id, g]));
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
