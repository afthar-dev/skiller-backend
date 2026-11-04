import type { Prisma } from "@prisma/client";

/**
 * Moves `hashtags.reelCount` for tags gained and lost by a reel, inside the reel's transaction. One statement per tag, in tag order across gains and losses
 * together, so two transactions touching overlapping tags always lock rows in the same order (no deadlock). Counts never go below zero.
 */
export async function adjustHashtags(tx: Prisma.TransactionClient, change: { add?: readonly string[]; remove?: readonly string[] }, at: Date): Promise<void> {
  const delta = new Map<string, number>();
  for (const tag of change.add ?? []) delta.set(tag, (delta.get(tag) ?? 0) + 1);
  for (const tag of change.remove ?? []) delta.set(tag, (delta.get(tag) ?? 0) - 1);
  for (const [tag, d] of [...delta.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (d > 0) {
      await tx.$executeRaw`INSERT INTO "hashtags" ("tag", "reelCount", "lastUsedAt") VALUES (${tag}, ${d}, ${at})
        ON CONFLICT ("tag") DO UPDATE SET "reelCount" = "hashtags"."reelCount" + ${d}, "lastUsedAt" = GREATEST("hashtags"."lastUsedAt", ${at})`;
    } else if (d < 0) {
      await tx.$executeRaw`UPDATE "hashtags" SET "reelCount" = GREATEST("reelCount" + ${d}, 0) WHERE "tag" = ${tag}`;
    }
  }
}
