-- Migration: sho274_chat_turn_frames
-- PG: prisma/migrations/20261031120000_sho274_chat_turn_frames
--
-- The write-ahead turn journal (SHO-274). A turn's raw SSE frames are inserted
-- here *before* they are forwarded to the client, so what a person has seen is
-- always a subset of what is stored, whichever process dies. Recovery replays
-- the frames for a dead turn through the same parser that wrote the row.
--
-- Append-only: one row per batch of frames, `seq` = batch order. The unique key
-- makes a retried insert idempotent; frames are deleted when their turn
-- completes (or after a recovery) and swept after 48 h.

-- CreateTable
CREATE TABLE "chat_turn_frames" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_turn_frames_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_turn_frames_turnId_seq_key" ON "chat_turn_frames"("turnId", "seq");

-- CreateIndex
CREATE INDEX "chat_turn_frames_sessionId_turnId_idx" ON "chat_turn_frames"("sessionId", "turnId");

-- CreateIndex
CREATE INDEX "chat_turn_frames_createdAt_idx" ON "chat_turn_frames"("createdAt");
