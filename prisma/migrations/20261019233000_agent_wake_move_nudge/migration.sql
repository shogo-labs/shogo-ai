-- Migration: agent_wake_move_nudge
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns, JSON stored as TEXT)
--
-- A move into a column that binds no agent hands the card back to its own
-- developer as a *hint*, not a run: the row is debounced by `notBefore` so the
-- mover's own tag in the same breath supersedes it, and a bounce that nobody
-- tags still wakes somebody when the window closes.

-- AlterTable
ALTER TABLE "agent_wakes" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'wake';
ALTER TABLE "agent_wakes" ADD COLUMN "notBefore" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_wakes_status_notBefore_idx" ON "agent_wakes"("status", "notBefore");
