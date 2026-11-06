-- AlterEnum
ALTER TYPE "CampaignRecipientStatus" ADD VALUE 'SENDING';
ALTER TYPE "CampaignRecipientStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "lastEditedById" TEXT,
ADD COLUMN "approvalHash" TEXT;

-- AlterTable
ALTER TABLE "campaign_recipients" DROP COLUMN "claimedAt",
ADD COLUMN "sendingAt" TIMESTAMP(3);
