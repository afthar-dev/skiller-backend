import { Prisma } from "@prisma/client";

/** Adds `by` to one counter in a campaign's `stats` JSON, in one statement (concurrent workers never lose a count). */
export function bumpStat(db: Prisma.TransactionClient, campaignId: string, stat: string, by = 1) {
  return db.$executeRaw(Prisma.sql`
    UPDATE "campaigns" SET "stats" = jsonb_set(COALESCE("stats", '{}'::jsonb), ARRAY[${stat}]::text[], to_jsonb(COALESCE(("stats"->>${stat})::int, 0) + ${by}::int))
    WHERE "id" = ${campaignId}`);
}
