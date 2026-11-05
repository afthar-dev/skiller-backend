-- Hand-written objects below (Prisma cannot express them; see README "Hand-written database objects"): the gigs search vector column's trigger and the
-- partial indexes of the live-gig catalog. pg_trgm already exists (course search migration).

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'GIG';

-- AlterTable
ALTER TABLE "gigs" ADD COLUMN     "searchVector" tsvector,
ADD COLUMN     "startingPricePaise" BIGINT;

-- AlterTable
ALTER TABLE "reels" ADD COLUMN     "linkedGigId" TEXT;

-- Starting price = the lowest package price (the gigs service keeps it current on every package write).
UPDATE "gigs" g SET "startingPricePaise" = (SELECT min(p."pricePaise") FROM "gig_packages" p WHERE p."gigId" = g."id");

-- Search document: title (A), tags (B), description (C), `simple` configuration (gig text is multilingual: no stemming, no stop words).
CREATE FUNCTION gigs_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW."tags", ' '), '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW."description", '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER gigs_search_vector_trg BEFORE INSERT OR UPDATE OF "title", "tags", "description" ON "gigs"
  FOR EACH ROW EXECUTE FUNCTION gigs_search_vector_update();

-- Index existing rows (the SET list names the trigger's columns, so it fires).
UPDATE "gigs" SET "title" = "title";

-- Partial indexes: the public catalog reads ACTIVE gigs only, so nothing else is indexed.
CREATE INDEX "gigs_active_search_idx" ON "gigs" USING GIN ("searchVector") WITH (fastupdate = off) WHERE "status" = 'ACTIVE';
CREATE INDEX "gigs_active_title_trgm_idx" ON "gigs" USING GIN ("title" gin_trgm_ops) WITH (fastupdate = off) WHERE "status" = 'ACTIVE';
CREATE INDEX "gigs_active_newest_idx" ON "gigs" ("publishedAt" DESC, "id" DESC) WHERE "status" = 'ACTIVE';
CREATE INDEX "gigs_active_price_idx" ON "gigs" ("startingPricePaise", "id") WHERE "status" = 'ACTIVE';
