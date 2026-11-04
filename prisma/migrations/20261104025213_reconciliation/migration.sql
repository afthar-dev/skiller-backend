-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OK', 'MISMATCH', 'ERROR');

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL,
    "details" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_date_key" ON "reconciliation_runs"("date");

-- CreateIndex
CREATE INDEX "reconciliation_runs_createdAt_idx" ON "reconciliation_runs"("createdAt");
