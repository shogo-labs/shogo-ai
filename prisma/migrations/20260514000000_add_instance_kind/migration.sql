-- Add an InstanceKind enum + Instance.kind column so we can distinguish
-- desktop sign-ins from `shogo worker` CLI sign-ins. Existing rows
-- become 'desktop' (the safe default — only the desktop app existed
-- before this change).

CREATE TYPE "InstanceKind" AS ENUM ('desktop', 'cli_worker');

ALTER TABLE "instances"
  ADD COLUMN "kind" "InstanceKind" NOT NULL DEFAULT 'desktop';

CREATE INDEX "instances_workspaceId_kind_idx" ON "instances"("workspaceId", "kind");
