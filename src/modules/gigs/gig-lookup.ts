import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

export interface GigCard {
  id: string;
  slug: string;
  title: string;
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
}
