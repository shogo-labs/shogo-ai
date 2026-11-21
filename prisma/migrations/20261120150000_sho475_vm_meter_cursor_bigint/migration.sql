-- SHO-475: agentMs / appMs / idleMs overflow int32 after 24.8 days.
-- Widen all three cumulative-ms counters to BIGINT (safe up to ~285,000 years).
-- Run in both US and EU regions before deploying the new ingest.ts; see PR body
-- for the per-region rollout order and post-deploy subscription health check.

ALTER TABLE "vm_meter_cursors" ALTER COLUMN "agentMs" SET DATA TYPE BIGINT;
ALTER TABLE "vm_meter_cursors" ALTER COLUMN "appMs" SET DATA TYPE BIGINT;
ALTER TABLE "vm_meter_cursors" ALTER COLUMN "idleMs" SET DATA TYPE BIGINT;
