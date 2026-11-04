-- pg_trgm is a trusted extension (PostgreSQL 13+): no superuser needed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "enrolments30d" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ownerName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "searchVector" tsvector;

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "reply" TEXT,
    "repliedAt" TIMESTAMP(3),
    "repliedById" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isInstructor" BOOLEAN NOT NULL DEFAULT false,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_courseId_hiddenAt_id_idx" ON "reviews"("courseId", "hiddenAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_courseId_userId_key" ON "reviews"("courseId", "userId");

-- CreateIndex
CREATE INDEX "questions_lessonId_hiddenAt_id_idx" ON "questions"("lessonId", "hiddenAt", "id");

-- CreateIndex
CREATE INDEX "answers_questionId_hiddenAt_id_idx" ON "answers"("questionId", "hiddenAt", "id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express them): keep them out of any later migrate dev DROP/CREATE.
CREATE INDEX "courses_search_vector_idx" ON "courses" USING GIN ("searchVector");
CREATE INDEX "courses_title_trgm_idx" ON "courses" USING GIN ("title" gin_trgm_ops);

-- Backfill the owner name and the search document of the courses that exist today (the application maintains both from now on).
UPDATE "courses" c SET "ownerName" = p."displayName" FROM "profiles" p WHERE c."ownerType" = 'USER' AND p."userId" = c."ownerId";
UPDATE "courses" c SET "ownerName" = o."name" FROM "organizations" o WHERE c."ownerType" = 'ORG' AND o."id" = c."ownerId";
UPDATE "courses" SET "searchVector" =
  setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("subtitle", '')), 'B') ||
  setweight(to_tsvector('simple', array_to_string("tags", ' ')), 'B') ||
  setweight(to_tsvector('simple', coalesce("description", '')), 'C') ||
  setweight(to_tsvector('simple', coalesce("ownerName", '')), 'C');
