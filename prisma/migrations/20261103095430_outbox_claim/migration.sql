-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3);
