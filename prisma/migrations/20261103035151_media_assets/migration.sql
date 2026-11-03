-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('AVATAR', 'BANNER', 'THUMBNAIL', 'GIG_GALLERY', 'REEL', 'COURSE_LESSON', 'COURSE_RESOURCE');

-- CreateEnum
CREATE TYPE "MediaBucket" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "bucket" "MediaBucket" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "objectKey" TEXT NOT NULL,
    "filename" TEXT,
    "mime" TEXT NOT NULL,
    "declaredSize" BIGINT NOT NULL,
    "uploadId" TEXT,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "renditions" JSONB,
    "posterKey" TEXT,
    "failureReason" TEXT,
    "attachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_assets_ownerId_createdAt_idx" ON "media_assets"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "media_assets_attachedAt_createdAt_idx" ON "media_assets"("attachedAt", "createdAt");
