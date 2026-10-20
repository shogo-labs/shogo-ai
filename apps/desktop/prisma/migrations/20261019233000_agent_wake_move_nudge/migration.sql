-- Migration: agent_wake_move_nudge
-- Source:    prisma/schema.local.prisma (SQLite)
--
-- A move into a column that binds no agent hands the card back to its own
-- developer as a *hint*, not a run: the row is debounced by `notBefore` so the
-- mover's own tag in the same breath supersedes it, and a bounce that nobody
-- tags still wakes somebody when the window closes.
-- Mirrors prisma/migrations/20261019233000_agent_wake_move_nudge/migration.sql.

-- AlterTable
ALTER TABLE "agent_wakes" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'wake';
ALTER TABLE "agent_wakes" ADD COLUMN "notBefore" DATETIME;

-- CreateIndex
CREATE INDEX "agent_wakes_status_notBefore_idx" ON "agent_wakes"("status", "notBefore");
