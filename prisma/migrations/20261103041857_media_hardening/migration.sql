-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "detachedAt" TIMESTAMP(3),
ADD COLUMN     "sourceEtag" TEXT;

-- CreateIndex
CREATE INDEX "media_assets_ownerId_status_idx" ON "media_assets"("ownerId", "status");
