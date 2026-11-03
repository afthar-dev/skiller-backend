-- DropIndex
DROP INDEX "profiles_handle_pattern_idx";

-- DropIndex
DROP INDEX "users_email_pattern_idx";

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "deadAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE INDEX "outbox_events_deadAt_idx" ON "outbox_events"("deadAt");

-- CreateIndex
CREATE INDEX "profiles_handle_pattern_idx" ON "profiles"("handle" text_pattern_ops);

-- CreateIndex
CREATE INDEX "users_email_pattern_idx" ON "users"("email" text_pattern_ops);
