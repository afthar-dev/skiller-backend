-- CreateEnum
CREATE TYPE "PayoutAccountType" AS ENUM ('BANK', 'UPI');

-- CreateEnum
CREATE TYPE "PayoutAccountStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'INACTIVE');

-- CreateTable
CREATE TABLE "payout_accounts" (
    "id" TEXT NOT NULL,
    "ownerType" "SellerOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "PayoutAccountType" NOT NULL,
    "status" "PayoutAccountStatus" NOT NULL DEFAULT 'PENDING',
    "holderName" TEXT NOT NULL,
    "ifsc" TEXT,
    "accountLast4" TEXT,
    "vpaMasked" TEXT,
    "panLast4" TEXT NOT NULL,
    "panHash" TEXT NOT NULL,
    "panNameMatch" BOOLEAN,
    "reviewFlag" TEXT,
    "razorpayxContactId" TEXT NOT NULL,
    "razorpayxFundAccountId" TEXT NOT NULL,
    "failureReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_accounts_razorpayxFundAccountId_key" ON "payout_accounts"("razorpayxFundAccountId");

-- CreateIndex
CREATE INDEX "payout_accounts_ownerType_ownerId_createdAt_idx" ON "payout_accounts"("ownerType", "ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "payout_accounts_panHash_idx" ON "payout_accounts"("panHash");

-- CreateIndex
CREATE INDEX "payout_accounts_reviewFlag_idx" ON "payout_accounts"("reviewFlag");

-- One live (not INACTIVE) payout account per owner; replacing the account retires the old row first.
CREATE UNIQUE INDEX "payout_accounts_owner_live_key" ON "payout_accounts"("ownerType", "ownerId") WHERE "status" <> 'INACTIVE';
