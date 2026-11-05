import { Injectable, OnModuleInit } from "@nestjs/common";
import type { GigStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ModerationTargetRegistry } from "../moderation";

/**
 * Gigs as reportable content (GIG). A live gig can be reported; enough reports hide it (HIDDEN, off every public surface, still the seller's) until a
 * moderator decides: dismissed brings it back live, upheld removes it for good (REMOVED). A gig the seller paused or deleted meanwhile is left as the seller
 * left it by a dismissal; an upheld report still removes it (the strike is for the content, whatever state it is in).
 */
@Injectable()
export class GigModerationTargets implements OnModuleInit {
  constructor(
    private readonly registry: ModerationTargetRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: "GIG",
      // Whatever the state: a seller who deleted a reported gig is still struck when the reports are upheld.
      ownerOf: async (id) => (await this.prisma.gig.findUnique({ where: { id }, select: { sellerId: true } }))?.sellerId ?? null,
      reportable: async (id) => {
        const gig = await this.prisma.gig.findUnique({ where: { id }, select: { status: true } });
        return gig?.status === "ACTIVE" || gig?.status === "HIDDEN";
      },
      hide: (tx, id) => this.move(tx, id, ["ACTIVE"], "HIDDEN"),
      remove: (tx, id) => this.move(tx, id, ["ACTIVE", "HIDDEN", "PAUSED"], "REMOVED"),
      restore: (tx, id) => this.move(tx, id, ["HIDDEN"], "ACTIVE"),
      preview: async (id) => {
        const gig = await this.prisma.gig.findUnique({ where: { id }, select: { title: true, status: true } });
        return gig ? { text: gig.title, status: gig.status } : null;
      },
    });
  }

  private async move(tx: Prisma.TransactionClient, id: string, from: GigStatus[], to: GigStatus): Promise<boolean> {
    const changed = await tx.gig.updateMany({ where: { id, status: { in: from } }, data: { status: to } });
    return changed.count === 1;
  }
}
