-- CreateEnum
CREATE TYPE "ReelCommentStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'REMOVED', 'DELETED');

-- CreateTable
CREATE TABLE "reel_likes" (
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_likes_pkey" PRIMARY KEY ("reelId","userId")
);

-- CreateTable
CREATE TABLE "reel_saves" (
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_saves_pkey" PRIMARY KEY ("reelId","userId")
);

-- CreateTable
CREATE TABLE "reel_shares" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT,
    "channel" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_comments" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "status" "ReelCommentStatus" NOT NULL DEFAULT 'VISIBLE',
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reel_likes_userId_createdAt_idx" ON "reel_likes"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "reel_saves_userId_createdAt_reelId_idx" ON "reel_saves"("userId", "createdAt", "reelId");

-- CreateIndex
CREATE INDEX "reel_shares_reelId_createdAt_idx" ON "reel_shares"("reelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reel_shares_reelId_userId_day_key" ON "reel_shares"("reelId", "userId", "day");

-- CreateIndex
CREATE INDEX "reel_comments_reelId_parentId_id_idx" ON "reel_comments"("reelId", "parentId", "id");

-- CreateIndex
CREATE INDEX "reel_comments_parentId_status_id_idx" ON "reel_comments"("parentId", "status", "id");

-- AddForeignKey
ALTER TABLE "reel_likes" ADD CONSTRAINT "reel_likes_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_saves" ADD CONSTRAINT "reel_saves_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_shares" ADD CONSTRAINT "reel_shares_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "reel_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
