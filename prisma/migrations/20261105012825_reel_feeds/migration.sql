-- Hand-written objects below (Prisma cannot express them; see README "Hand-written database objects"): the reels search vector column's
-- trigger and its two GIN indexes. pg_trgm already exists (course search migration).

-- AlterTable
ALTER TABLE "reels" ADD COLUMN     "searchVector" tsvector;

-- CreateTable
CREATE TABLE "user_interests" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_interests_pkey" PRIMARY KEY ("userId","key")
);

-- CreateIndex
CREATE INDEX "user_interests_userId_weight_idx" ON "user_interests"("userId", "weight" DESC);

-- CreateIndex
CREATE INDEX "reels_status_publishedAt_id_idx" ON "reels"("status", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "reels_hashtags_idx" ON "reels" USING GIN ("hashtags");

-- Search document: caption (A) and hashtags (B), `simple` configuration (reel text is multilingual: no stemming, no stop words).
CREATE FUNCTION reels_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', coalesce(NEW."caption", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW."hashtags", ' '), '')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER reels_search_vector_trg BEFORE INSERT OR UPDATE OF "caption", "hashtags" ON "reels"
  FOR EACH ROW EXECUTE FUNCTION reels_search_vector_update();

-- Index existing rows (the SET list names the trigger's columns, so it fires).
UPDATE "reels" SET "caption" = "caption";

CREATE INDEX "reels_search_vector_idx" ON "reels" USING GIN ("searchVector") WITH (fastupdate = off);
CREATE INDEX "reels_caption_trgm_idx" ON "reels" USING GIN ("caption" gin_trgm_ops) WITH (fastupdate = off);
