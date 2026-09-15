-- Flip the Slack routing model from opt-in to opt-out: once a workspace
-- admin installs the Shogo Agent for Slack app (the real opt-in gate),
-- every project in that workspace is reachable from Slack unless an admin
-- explicitly disables it. Update the column default for future inserts
-- and backfill existing rows so pre-existing projects aren't silently
-- excluded from the new default.
ALTER TABLE "projects"
ALTER COLUMN "slackEnabled" SET DEFAULT true;

UPDATE "projects"
SET "slackEnabled" = true
WHERE "slackEnabled" = false;
