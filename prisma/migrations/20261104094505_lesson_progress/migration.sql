-- CreateTable
CREATE TABLE "lesson_progress" (
    "userId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "watchedSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("userId","lessonId")
);

-- CreateIndex
CREATE INDEX "lesson_progress_courseId_userId_idx" ON "lesson_progress"("courseId", "userId");

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
