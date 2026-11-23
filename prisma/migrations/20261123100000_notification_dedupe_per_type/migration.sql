-- Two handlers of one outbox event can notify the same user (media.ready and reel.limit_reached share an event id), and the old
-- (userId, sourceEventId) key made the second insert vanish under skipDuplicates. The new key is a strict superset, so every existing
-- row satisfies it; it is built before the old one is dropped, so the table is never without a duplicate guard.

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_sourceEventId_type_key" ON "notifications"("userId", "sourceEventId", "type");

-- DropIndex
DROP INDEX "notifications_userId_sourceEventId_key";
