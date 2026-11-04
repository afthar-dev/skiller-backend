-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "learnerName" TEXT NOT NULL,
    "courseTitle" TEXT NOT NULL,
    "issuerName" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "objectKey" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "certificates_code_key" ON "certificates"("code");

-- CreateIndex
CREATE INDEX "certificates_userId_issuedAt_idx" ON "certificates"("userId", "issuedAt");

-- CreateIndex
CREATE INDEX "certificates_courseId_idx" ON "certificates"("courseId");

-- Hand-written: at most one live certificate per learner and course (a revoked one does not count, so reissue after revoke works).
CREATE UNIQUE INDEX "certificates_live_key" ON "certificates"("userId", "courseId") WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
