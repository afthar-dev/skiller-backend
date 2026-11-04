-- Hand-written (Prisma cannot express generated columns, partial or expression indexes, or index storage parameters).
-- Keep every index and column below out of any later migrate dev DROP/CREATE.

-- Every published course has a publication date (the catalog's "newest" key and its index rely on it).
UPDATE "courses" SET "publishedAt" = "createdAt" WHERE "status" = 'PUBLISHED' AND "publishedAt" IS NULL;

-- The rating as the public sees it: 0 until 3 learners rated. A plain column, so the "rating" sort can use an index.
ALTER TABLE "courses" ADD COLUMN "ratingShown" numeric(3,2) GENERATED ALWAYS AS (CASE WHEN "ratingCount" >= 3 THEN COALESCE("ratingAvg", 0) ELSE 0 END) STORED;

-- The search document is read-mostly: no pending list (it skewed plans and made reads scan it).
DROP INDEX "courses_search_vector_idx";
CREATE INDEX "courses_search_vector_idx" ON "courses" USING GIN ("searchVector") WITH (fastupdate = off);

-- One partial index per catalog sort, over published, unflagged courses only; each ends in the id (the tie break and cursor key).
CREATE INDEX "courses_pub_popular_idx" ON "courses" ("enrolments30d" DESC, "enrolmentCount" DESC, "id" DESC) WHERE "status" = 'PUBLISHED' AND "flaggedAt" IS NULL AND "publishedAt" IS NOT NULL;
CREATE INDEX "courses_pub_newest_idx" ON "courses" ("publishedAt" DESC, "id" DESC) WHERE "status" = 'PUBLISHED' AND "flaggedAt" IS NULL AND "publishedAt" IS NOT NULL;
CREATE INDEX "courses_pub_rating_idx" ON "courses" ("ratingShown" DESC, "ratingCount" DESC, "id" DESC) WHERE "status" = 'PUBLISHED' AND "flaggedAt" IS NULL AND "publishedAt" IS NOT NULL;

-- The hourly popularity job counts enrolments of the last 30 days.
CREATE INDEX "enrolments_created_active_idx" ON "enrolments" ("createdAt") WHERE "revokedAt" IS NULL;
