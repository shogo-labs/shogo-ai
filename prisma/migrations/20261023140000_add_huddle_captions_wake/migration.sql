-- Migration: add_huddle_captions_wake
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, SQLite)
--
-- Saying "hey Shogo" in a huddle wakes the workspace agent with the last minute
-- of the call. `lastWakeAt` is claimed with a compare-and-set, so one wake runs
-- per huddle per 10 seconds no matter which pod saw the phrase; `huddle_wakes`
-- keeps one row per spoken wake, unique on the transcript item that carried it,
-- so a replayed or duplicated final can never start a second agent turn.

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN "lastWakeAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "huddle_wakes" (
    "id" TEXT NOT NULL,
    "huddleId" TEXT NOT NULL,
    "speakerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "huddle_wakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "huddle_wakes_huddleId_itemId_key" ON "huddle_wakes"("huddleId", "itemId");

-- CreateIndex
CREATE INDEX "huddle_wakes_huddleId_createdAt_idx" ON "huddle_wakes"("huddleId", "createdAt");

-- AddForeignKey
ALTER TABLE "huddle_wakes" ADD CONSTRAINT "huddle_wakes_huddleId_fkey" FOREIGN KEY ("huddleId") REFERENCES "huddles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
