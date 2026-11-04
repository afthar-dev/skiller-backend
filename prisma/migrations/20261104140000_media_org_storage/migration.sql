-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "orgId" TEXT;

-- CreateIndex
CREATE INDEX "media_assets_orgId_status_idx" ON "media_assets"("orgId", "status");
