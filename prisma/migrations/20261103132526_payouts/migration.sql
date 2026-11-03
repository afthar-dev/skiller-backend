-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'REVERSED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutMode" AS ENUM ('IMPS', 'UPI', 'NEFT');

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "ownerType" "SellerOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "payoutAccountId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "tdsBps" INTEGER NOT NULL,
    "tdsPaise" BIGINT NOT NULL,
    "mode" "PayoutMode" NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "razorpayxPayoutId" TEXT,
    "utr" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payouts_razorpayxPayoutId_key" ON "payouts"("razorpayxPayoutId");

-- CreateIndex
CREATE INDEX "payouts_ownerType_ownerId_id_idx" ON "payouts"("ownerType", "ownerId", "id");

-- CreateIndex
CREATE INDEX "payouts_status_createdAt_idx" ON "payouts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payouts_status_approvedAt_idx" ON "payouts"("status", "approvedAt");
