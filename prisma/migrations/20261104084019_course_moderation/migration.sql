-- AlterEnum
ALTER TYPE "MediaPurpose" ADD VALUE 'COURSE_PROMO';

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "courses_status_submittedAt_id_idx" ON "courses"("status", "submittedAt", "id");
