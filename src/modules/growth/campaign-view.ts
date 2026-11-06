import type { Campaign } from "@prisma/client";

export const STAT_KEYS = ["delivered", "opened", "clicked", "bounced", "complained"] as const;
export type StatKey = (typeof STAT_KEYS)[number];

const statsOf = (stats: unknown): Record<StatKey, number> => {
  const raw = (stats ?? {}) as Record<string, unknown>;
  return Object.fromEntries(STAT_KEYS.map((k) => [k, typeof raw[k] === "number" ? raw[k] : 0])) as Record<StatKey, number>;
};

/** What admins see of a campaign: its text, segment definition, state and counts. Never a member's address or id. */
export const toCampaignView = (c: Campaign) => ({
  id: c.id,
  name: c.name,
  subject: c.subject,
  bodyMarkdown: c.bodyMarkdown,
  segment: c.segment,
  status: c.status,
  scheduledAt: c.scheduledAt?.toISOString() ?? null,
  startedAt: c.startedAt?.toISOString() ?? null,
  finishedAt: c.finishedAt?.toISOString() ?? null,
  audienceSize: c.audienceSize,
  createdById: c.createdById,
  approvedById: c.approvedById,
  approvedAt: c.approvedAt?.toISOString() ?? null,
  stats: statsOf(c.stats),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});
