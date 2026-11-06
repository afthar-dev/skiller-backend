/** The criteria a campaign segment can use. Each is answered by the module that owns the data (see SegmentProvider). */
export const SEGMENT_KEYS = ["roles", "plan", "interests", "lastActive", "hasPurchased"] as const;
export type SegmentKey = (typeof SEGMENT_KEYS)[number];

/**
 * One criterion of a campaign segment, answered by the module that owns the data (rbac: roles, billing: plan and purchases, reels: interests,
 * identity: last activity), so growth never reads another module's tables. `match` gets a bounded page of candidate user ids and returns those
 * that satisfy the criterion; growth streams the audience page by page and narrows each page criterion by criterion, so no audience-sized set
 * is ever held in memory.
 */
export interface SegmentProvider {
  readonly key: SegmentKey;
  match(userIds: string[], criterion: unknown): Promise<Set<string>>;
}
