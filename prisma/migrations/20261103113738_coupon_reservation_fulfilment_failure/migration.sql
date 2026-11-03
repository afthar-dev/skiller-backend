-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('RESERVED', 'REDEEMED', 'RELEASED');

-- DropIndex
DROP INDEX "coupon_redemptions_couponId_userId_key";

-- AlterTable
ALTER TABLE "coupon_redemptions" ADD COLUMN     "status" "RedemptionStatus" NOT NULL DEFAULT 'REDEEMED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fulfilmentError" TEXT,
ADD COLUMN     "fulfilmentFailedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "coupon_redemptions_couponId_status_idx" ON "coupon_redemptions"("couponId", "status");

-- CreateIndex
CREATE INDEX "coupon_redemptions_couponId_userId_idx" ON "coupon_redemptions"("couponId", "userId");

-- One live (RESERVED or REDEEMED) redemption per user per coupon; RELEASED rows are history. Hand-written: Prisma cannot express partial indexes.
CREATE UNIQUE INDEX "coupon_redemptions_live_user_key" ON "coupon_redemptions"("couponId", "userId") WHERE "status" IN ('RESERVED', 'REDEEMED');
