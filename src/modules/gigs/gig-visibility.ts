import { Injectable } from "@nestjs/common";
import { UserStatusCache } from "../identity";
import { UserBlocks } from "../moderation";

/**
 * The one seam every gig surface passes through for "may this viewer see what this seller offers?": the seller's account must be active
 * (a suspended or deleted account's gigs are out of every public read, and back when it is active again) and the seller and the viewer must not
 * have blocked each other (either way). Gig status itself (live or not) is the caller's query.
 */
@Injectable()
export class GigVisibility {
  constructor(
    private readonly blocks: UserBlocks,
    private readonly statuses: UserStatusCache,
  ) {}

  /** Of these sellers, the ones whose gigs `viewerId` (null = anonymous) may see. */
  async visibleSellers(viewerId: string | null, sellerIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(sellerIds)];
    if (unique.length === 0) return new Set();
    const [{ blocked }, statuses] = await Promise.all([this.blocks.relations(viewerId), this.statuses.getMany(unique)]);
    return new Set(unique.filter((id) => statuses.get(id) === "ACTIVE" && !blocked.has(id)));
  }
}
