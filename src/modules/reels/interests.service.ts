import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Daily multiplier on every weight: interests fade 2% a day. */
export const INTEREST_DECAY_PER_DAY = 0.98;
/** A weight below this has faded out; it is not returned (and the row is dropped by the cap below once it is the weakest). */
export const MIN_INTEREST_WEIGHT = 0.01;
/** At most this many interests are kept per user: the strongest ones. */
export const MAX_INTERESTS = 200;
const MS_PER_DAY = 24 * 3600_000;

export interface Interest {
  key: string;
  weight: number;
}

/**
 * What a signed-in user is interested in: weights on "tag:<hashtag>" and "cat:<categoryId>". The stored weight is as of `updatedAt`; decay
 * (0.98 per day) is applied when the row is read or added to, never by a sweep.
 */
@Injectable()
export class InterestsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Adds `weight` to each key: the old weight is decayed to `now` first. One statement, so concurrent events add up. */
  async add(userId: string, keys: string[], weight: number, now: Date): Promise<void> {
    if (keys.length === 0) return;
    await this.prisma.$executeRaw`
      INSERT INTO "user_interests" ("userId", "key", "weight", "updatedAt")
      SELECT ${userId}, k, ${weight}::float8, ${now} FROM unnest(${keys}::text[]) AS k
      ON CONFLICT ("userId", "key") DO UPDATE SET
        "weight" = "user_interests"."weight" * power(${INTEREST_DECAY_PER_DAY}::float8, GREATEST(0, EXTRACT(EPOCH FROM (EXCLUDED."updatedAt" - "user_interests"."updatedAt")) / 86400)) + EXCLUDED."weight",
        "updatedAt" = GREATEST(EXCLUDED."updatedAt", "user_interests"."updatedAt")`;
    await this.prisma.$executeRaw`
      DELETE FROM "user_interests" WHERE "userId" = ${userId} AND "key" IN (
        SELECT "key" FROM "user_interests" WHERE "userId" = ${userId} ORDER BY "weight" DESC, "key" OFFSET ${MAX_INTERESTS})`;
  }

  /** The user's interests as of `now`, strongest first, faded ones left out. Reading changes nothing. */
  async weights(userId: string, now: Date): Promise<Interest[]> {
    const rows = await this.prisma.userInterest.findMany({ where: { userId }, orderBy: [{ weight: "desc" }, { key: "asc" }], take: MAX_INTERESTS });
    return rows
      .map((r) => ({ key: r.key, weight: r.weight * INTEREST_DECAY_PER_DAY ** Math.max(0, (now.getTime() - r.updatedAt.getTime()) / MS_PER_DAY) }))
      .filter((r) => r.weight >= MIN_INTEREST_WEIGHT)
      .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1));
  }
}
