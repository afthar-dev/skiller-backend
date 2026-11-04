import { Prisma, type CourseOwnerType } from "@prisma/client";

/** The only `$executeRaw` the helpers below need, so a PrismaService and a transaction client both fit. */
type Db = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * The text a course is found by, in the `simple` configuration (no stemming, no stop words: course text is multilingual): title A,
 * subtitle and tags B, description and the owner's name C. `owner` is the SQL for the owner name, so a rename can index the new name in
 * the same statement that stores it (inside an UPDATE, a column on the right-hand side still holds its old value).
 */
const document = (owner: Prisma.Sql) => Prisma.sql`
  setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("subtitle", '')), 'B') ||
  setweight(to_tsvector('simple', array_to_string("tags", ' ')), 'B') ||
  setweight(to_tsvector('simple', coalesce("description", '')), 'C') ||
  setweight(to_tsvector('simple', ${owner}), 'C')`;

/** Rebuilds one course's search document from its row. Call in the transaction that changes the title, subtitle, tags or description. */
export function refreshCourseSearch(db: Db, courseId: string): Promise<number> {
  return db.$executeRaw`UPDATE "courses" SET "searchVector" = ${document(Prisma.sql`coalesce("ownerName", '')`)} WHERE "id" = ${courseId}`;
}

/** Stores a new owner name on every course of that owner and re-indexes them, in one statement. Idempotent. */
export function refreshOwnerSearch(db: Db, ownerType: CourseOwnerType, ownerId: string, ownerName: string): Promise<number> {
  return db.$executeRaw`
    UPDATE "courses" SET "ownerName" = ${ownerName}, "searchVector" = ${document(Prisma.sql`${ownerName}::text`)}
    WHERE "ownerType" = ${ownerType}::"CourseOwnerType" AND "ownerId" = ${ownerId}`;
}
