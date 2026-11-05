import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

export type VisibilitySubject = { reelIds: string[] } | { creatorIds: string[] };

/**
 * The one seam every list of reels passes through before it is shown (feeds, hashtag pages, search). It answers "which of these may this
 * viewer see?" and returns them in the order given.
 *
 * Today: a reel is visible exactly while it is PUBLISHED (hidden, removed, deleted, processing and failed reels never are), and every creator is
 * visible. Task 6 adds the rest here, in one place: blocks in both directions, muted creators, and creators whose content moderation holds back.
 */
@Injectable()
export class ReelVisibility {
  constructor(private readonly prisma: PrismaService) {}

  // `_viewerId` is unused until blocks and mutes arrive; it is part of the contract now so no caller has to change then.
  async filterVisible(_viewerId: string | null, subject: VisibilitySubject): Promise<string[]> {
    if ("creatorIds" in subject) return subject.creatorIds;
    if (subject.reelIds.length === 0) return [];
    const rows = await this.prisma.reel.findMany({ where: { id: { in: subject.reelIds }, status: "PUBLISHED" }, select: { id: true } });
    const ok = new Set(rows.map((r) => r.id));
    return subject.reelIds.filter((id) => ok.has(id));
  }
}
