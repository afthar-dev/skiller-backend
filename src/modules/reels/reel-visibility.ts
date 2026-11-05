import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { UserStatusCache } from "../identity";
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
 * A reel is visible exactly while it is PUBLISHED (hidden, removed, deleted, processing and failed reels never are), while its creator's account is active (a
 * suspended or deleted account's reels and comments are out of every public read, and back when it is active again), and not when its creator and the viewer
 * have blocked each other (either way: a block hides both sides) or, in discovery lists, when the viewer muted the creator. The viewer's blocks and mutes come
 * from one cached lookup per viewer (UserBlocks.relations).
 */
@Injectable()
export class ReelVisibility {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocks: UserBlocks,
    private readonly statuses: UserStatusCache,
  ) {}

  /** Of these users, the ones whose account is suspended or deleted: what they posted is not shown. One batched, briefly cached lookup (UserStatusCache). */
  async inactiveUsers(userIds: string[]): Promise<Set<string>> {
    const statuses = await this.statuses.getMany(userIds);
    return new Set([...statuses].filter(([, status]) => status !== "ACTIVE").map(([id]) => id));
  }

  async filterVisible(viewerId: string | null, subject: VisibilitySubject, opts: VisibilityOptions = {}): Promise<string[]> {
    const { blocked, muted } = await this.blocks.relations(viewerId);
    const hides = (creatorId: string) => blocked.has(creatorId) || (opts.mutes !== false && muted.has(creatorId));
    if ("creatorIds" in subject) {
      const inactive = await this.inactiveUsers(subject.creatorIds);
      return subject.creatorIds.filter((id) => !hides(id) && !inactive.has(id));
    }
    if (subject.reelIds.length === 0) return [];
    const rows = await this.prisma.reel.findMany({ where: { id: { in: subject.reelIds }, status: "PUBLISHED" }, select: { id: true, creatorId: true } });
    const inactive = await this.inactiveUsers(rows.map((r) => r.creatorId));
    const ok = new Set(rows.filter((r) => !hides(r.creatorId) && !inactive.has(r.creatorId)).map((r) => r.id));
    return subject.reelIds.filter((id) => ok.has(id));
  }
}
