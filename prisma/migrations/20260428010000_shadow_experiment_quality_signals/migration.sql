-- Phase 3.2 — extend ModelExperiment with quality-signal counters and an
-- expected-end timestamp so we can run the two-week shadow A/B on the
-- explore sub-agent and call a winner with the same multi-signal gate the
-- recommendations path uses.

ALTER TABLE "model_experiments"
  ADD COLUMN IF NOT EXISTS "expectedEndAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalationsA"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "escalationsB"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "loopDetectedA"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "loopDetectedB"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hitMaxTurnsA"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hitMaxTurnsB"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "responseEmptyA" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "responseEmptyB" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "model_experiments_workspaceId_agentType_status_idx"
  ON "model_experiments" ("workspaceId", "agentType", "status");
