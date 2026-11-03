-- AlterTable: the signature covers the body but not the event-id header, so dedupe on the body hash too.
ALTER TABLE "webhook_events" ADD COLUMN "bodySha256" TEXT;
-- Rows stored before this migration have no recorded hash; give them unique placeholders.
UPDATE "webhook_events" SET "bodySha256" = 'legacy:' || "id";
ALTER TABLE "webhook_events" ALTER COLUMN "bodySha256" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_bodySha256_key" ON "webhook_events"("provider", "bodySha256");
