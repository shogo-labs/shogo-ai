-- AlterTable: Add heartbeat scheduling columns
ALTER TABLE "agent_configs" ADD COLUMN "nextHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "agent_configs" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "agent_configs" ADD COLUMN "quietHoursStart" TEXT;
ALTER TABLE "agent_configs" ADD COLUMN "quietHoursEnd" TEXT;
ALTER TABLE "agent_configs" ADD COLUMN "quietHoursTimezone" TEXT;

-- Backfill: seed nextHeartbeatAt for existing agents with heartbeat enabled.
-- Spreads them over the next interval using random() for jitter.
UPDATE "agent_configs"
SET "nextHeartbeatAt" = NOW() + ("heartbeatInterval" * INTERVAL '1 second')
                        + (random() * "heartbeatInterval" * 0.1 * INTERVAL '1 second')
WHERE "heartbeatEnabled" = true
  AND "nextHeartbeatAt" IS NULL;

-- Partial index for the scheduler's polling query
CREATE INDEX "idx_agent_configs_heartbeat_schedule"
ON "agent_configs" ("nextHeartbeatAt")
WHERE "heartbeatEnabled" = true;
