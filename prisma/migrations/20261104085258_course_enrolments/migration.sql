-- CreateEnum
CREATE TYPE "EnrolmentSource" AS ENUM ('PURCHASE', 'FREE', 'ORG_SEAT');

-- CreateTable
CREATE TABLE "enrolments" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "EnrolmentSource" NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "progressPct" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrolments_userId_id_idx" ON "enrolments"("userId", "id");

-- CreateIndex
CREATE INDEX "enrolments_orderId_idx" ON "enrolments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_courseId_userId_key" ON "enrolments"("courseId", "userId");

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
