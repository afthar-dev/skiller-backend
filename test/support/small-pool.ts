import type { Redis } from "ioredis";

/**
 * Pins the app's database pool to a handful of connections, like CI's 1-CPU runner (Prisma sizes the pool by CPU count). Call it before
 * createAuthTestApp(). Code that needs a second pooled connection while it holds one inside an interactive transaction then deadlocks when
 * requests run in parallel: each holds one connection and waits for another until Prisma gives up with P2024 (HTTP 500).
 */
export function pinSmallPool(connections = 3): void {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("connection_limit", String(connections));
  process.env.DATABASE_URL = url.toString();
}

/** More parallel requests than the pinned pool has connections, so every connection is held by a transaction at once. */
export const BURST = 6;

/** Forgets the cached plan of these users so the next entitlement read goes to the database (the case that used to need a second connection). */
export async function coldEntitlements(redis: Redis, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    const keys = await redis.keys(`ent:USER:${id}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
}

/** Status codes of a burst, for `expect(statuses(res)).toEqual(Array(n).fill(200))`: nothing may be a 5xx. */
export const statuses = (results: Array<{ status: number }>): number[] => results.map((r) => r.status);
