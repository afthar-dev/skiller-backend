import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { UserBlocks } from "../moderation";

export type VisibilitySubject = { reelIds: string[] } | { creatorIds: string[] };

export interface VisibilityOptions {
  /**
   * Also drop creators the viewer muted. True (the default) for discovery lists: feeds, hashtag pages, search. A mute only shapes what is pushed at you,
   * so direct reel pages, profile tabs, saved reels and comments pass `mutes: false`.
   */
  mutes?: boolean;
}

/**
 * The one seam every list or page of reels passes through before it is shown. It answers "which of these may this viewer see?" and returns them
 * in the order given.
 *
 * A reel is visible exactly while it is PUBLISHED (hidden, removed, deleted, processing and failed reels never are), and not when its creator and the viewer
 * have blocked each other (either way: a block hides both sides) or, in discovery lists, when the viewer muted the creator. The viewer's blocks and mutes come
 * from one cached lookup per viewer (UserBlocks.relations).
 */
@Injectable()
export class ReelVisibility {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocks: UserBlocks,
  ) {}

  async filterVisible(viewerId: string | null, subject: VisibilitySubject, opts: VisibilityOptions = {}): Promise<string[]> {
    const { blocked, muted } = await this.blocks.relations(viewerId);
    const hides = (creatorId: string) => blocked.has(creatorId) || (opts.mutes !== false && muted.has(creatorId));
    if ("creatorIds" in subject) return subject.creatorIds.filter((id) => !hides(id));
    if (subject.reelIds.length === 0) return [];
    const rows = await this.prisma.reel.findMany({ where: { id: { in: subject.reelIds }, status: "PUBLISHED" }, select: { id: true, creatorId: true } });
    const ok = new Set(rows.filter((r) => !hides(r.creatorId)).map((r) => r.id));
    return subject.reelIds.filter((id) => ok.has(id));
  }
}
