-- CreateIndex
CREATE INDEX "reels_creatorId_createdAt_id_idx" ON "reels"("creatorId", "createdAt" DESC, "id" DESC);
