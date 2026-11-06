import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SEGMENT_KEYS, type SegmentProvider } from "../../common/segments/segment-provider";
import { AccountService } from "../identity";

export const SEGMENT_PROVIDERS = Symbol("SEGMENT_PROVIDERS");

const values = z.array(z.string().trim().min(1).max(100)).min(1).max(20);
const days = z.number().int().min(1).max(3650);

/**
 * Who a campaign goes to. Every criterion is optional; the ones present must all hold (AND), and a list matches when any of its values does (OR).
 * `{}` is every active member. Evaluated by the module that owns each fact (SegmentProvider), never by reading their tables here.
 */
export const segmentSchema = z
  .object({
    roles: values.optional(),
    plan: values.optional(),
    interests: values.optional(),
    lastActive: z.union([z.object({ withinDays: days }).strict(), z.object({ inactiveDays: days }).strict()]).optional(),
    hasPurchased: z.boolean().optional(),
  })
  .strict();
export type Segment = z.infer<typeof segmentSchema>;

/** Audiences above this need a second admin's approval. */
export const APPROVAL_THRESHOLD = 10_000;
const PAGE = 1000;

/** Walks the audience in pages of active members (by id), narrowing each page criterion by criterion; memory use does not grow with the audience. */
@Injectable()
export class SegmentEvaluator {
  private readonly providers: Map<string, SegmentProvider>;

  constructor(
    private readonly accounts: AccountService,
    @Inject(SEGMENT_PROVIDERS) providers: SegmentProvider[],
  ) {
    this.providers = new Map(providers.map((p) => [p.key, p]));
  }

  /** Calls `onPage` with each non-empty page of matching user ids, in id order. */
  async stream(segment: Segment, onPage: (userIds: string[]) => Promise<void>): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const ids = await this.accounts.activeIdsAfter(cursor, PAGE);
      if (ids.length === 0) return;
      cursor = ids[ids.length - 1];
      let matched = ids;
      for (const key of SEGMENT_KEYS) {
        if (matched.length === 0) break;
        const criterion = segment[key];
        if (criterion === undefined) continue;
        const provider = this.providers.get(key);
        if (!provider) throw new Error(`no segment provider for ${key}`);
        const keep = await provider.match(matched, criterion);
        matched = matched.filter((id) => keep.has(id));
      }
      if (matched.length > 0) await onPage(matched);
      if (ids.length < PAGE) return;
    }
  }

  async count(segment: Segment): Promise<number> {
    let total = 0;
    await this.stream(segment, async (ids) => {
      total += ids.length;
    });
    return total;
  }
}
