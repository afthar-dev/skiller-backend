import test from "node:test";
import assert from "node:assert/strict";
import { findDrift } from "./check-schema-drift-lib.mjs";

const NOISE = `
-- DropIndex
DROP INDEX "courses_search_vector_idx";

-- DropIndex
DROP INDEX "courses_title_trgm_idx";

-- DropIndex
DROP INDEX "reels_search_vector_idx";

-- DropIndex
DROP INDEX "reels_caption_trgm_idx";

-- DropIndex
DROP INDEX "gigs_active_search_idx";

-- DropIndex
DROP INDEX "gigs_active_title_trgm_idx";

-- DropIndex
DROP INDEX "gigs_active_newest_idx";

-- DropIndex
DROP INDEX "gigs_active_price_idx";

-- DropIndex
DROP INDEX "profiles_handle_pattern_idx";

-- DropIndex
DROP INDEX "users_email_pattern_idx";

-- AlterTable
ALTER TABLE "courses" ALTER COLUMN "ratingShown" DROP DEFAULT,
ALTER COLUMN "ratingShown" SET DATA TYPE numeric(3,2);

-- CreateIndex
CREATE INDEX "profiles_handle_pattern_idx" ON "profiles"("handle" text_pattern_ops);

-- CreateIndex
CREATE INDEX "users_email_pattern_idx" ON "users"("email" text_pattern_ops);
`;

test("pure known noise is clean", () => {
  assert.deepEqual(findDrift(NOISE), []);
});

test("a real column added in the same ALTER TABLE as ratingShown noise is drift", () => {
  const sql = `-- AlterTable
ALTER TABLE "courses" ADD COLUMN "x" TEXT,
ALTER COLUMN "ratingShown" DROP DEFAULT,
ALTER COLUMN "ratingShown" SET DATA TYPE numeric(3,2);
`;
  const drift = findDrift(sql);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /ADD COLUMN "x" TEXT/);
  assert.doesNotMatch(drift[0], /ratingShown/);
});

test("a different change to ratingShown is drift", () => {
  assert.equal(findDrift('ALTER TABLE "courses" ALTER COLUMN "ratingShown" SET DEFAULT 0;').length, 1);
});

test("same noise on another table is drift", () => {
  assert.equal(findDrift('ALTER TABLE "reviews" ALTER COLUMN "ratingShown" DROP DEFAULT;').length, 1);
});

test("index statements must match exactly", () => {
  assert.equal(findDrift('CREATE INDEX "users_email_pattern_idx" ON "users"("email");').length, 1);
  assert.equal(findDrift('DROP INDEX "users_email_pattern_idx_other";').length, 1);
  assert.equal(findDrift('DROP INDEX "users_email_pattern_idx"; DROP TABLE "x";').length, 1);
});
