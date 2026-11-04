-- CreateEnum
CREATE TYPE "ReelStatus" AS ENUM ('PROCESSING', 'PUBLISHED', 'HIDDEN', 'REMOVED', 'DELETED', 'FAILED', 'LIMIT_REACHED');

-- CreateTable
CREATE TABLE "reels" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[],
    "linkedCourseId" TEXT,
    "status" "ReelStatus" NOT NULL DEFAULT 'PROCESSING',
    "commentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "failureReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "saveCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "watchSecTotal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hashtags" (
    "tag" TEXT NOT NULL,
    "reelCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hashtags_pkey" PRIMARY KEY ("tag")
);

-- CreateIndex
CREATE UNIQUE INDEX "reels_mediaAssetId_key" ON "reels"("mediaAssetId");

-- CreateIndex
CREATE INDEX "reels_creatorId_publishedAt_id_idx" ON "reels"("creatorId", "publishedAt", "id");

-- CreateIndex
CREATE INDEX "reels_creatorId_status_id_idx" ON "reels"("creatorId", "status", "id");
