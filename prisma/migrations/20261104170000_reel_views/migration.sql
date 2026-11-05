-- CreateTable
CREATE TABLE "reel_view_daily" (
    "reelId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "watchSec" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_view_daily_pkey" PRIMARY KEY ("reelId","day")
);

-- CreateTable
CREATE TABLE "reel_seen" (
    "userId" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "watchedPct" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reel_seen_pkey" PRIMARY KEY ("userId","reelId")
);

-- CreateTable
CREATE TABLE "reel_view_flushes" (
    "id" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_view_flushes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reel_seen_userId_lastSeenAt_idx" ON "reel_seen"("userId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "reel_view_daily" ADD CONSTRAINT "reel_view_daily_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_seen" ADD CONSTRAINT "reel_seen_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
