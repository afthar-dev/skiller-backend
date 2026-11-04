import { Prisma } from "@prisma/client";

/** The denormalised counters on a reel. Names are fixed here so a column name is never built from input. */
const COLUMNS = { likes: "likeCount", saves: "saveCount", shares: "shareCount", comments: "commentCount" } as const;
export type ReelCounter = keyof typeof COLUMNS;

/**
 * Moves one counter of a reel by `delta` and returns the new value. Call it only when a row really changed, in the same transaction as that
 * change: a conditional insert / delete that touched nothing must not move the counter. The floor at zero is a safety net, never a repair of drift.
 */
export async function bumpCounter(tx: Prisma.TransactionClient, reelId: string, counter: ReelCounter, delta: 1 | -1): Promise<number> {
  const column = Prisma.raw(`"${COLUMNS[counter]}"`);
  const rows = await tx.$queryRaw<{ value: number }[]>(Prisma.sql`UPDATE "reels" SET ${column} = GREATEST(${column} + ${delta}, 0) WHERE "id" = ${reelId} RETURNING ${column} AS "value"`);
  return rows[0]?.value ?? 0;
}

/** The current value of a counter (for an operation that changed nothing). */
export async function readCounter(tx: Prisma.TransactionClient, reelId: string, counter: ReelCounter): Promise<number> {
  const column = COLUMNS[counter];
  const reel = await tx.reel.findUnique({ where: { id: reelId }, select: { [column]: true } });
  return (reel as Record<string, number> | null)?.[column] ?? 0;
}
