-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "retiredHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "sessions_retiredHashes_idx" ON "sessions" USING GIN ("retiredHashes");
