-- CreateTable
CREATE TABLE "daily_metrics" (
    "day" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("day","key")
);
