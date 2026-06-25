-- Add per-workspace write-ownership region.
--
-- All writes to workspace-scoped rows are routed to this region so tenant data
-- is only ever written in one place, keeping active-active logical replication
-- conflict-free. Nullable: existing rows are backfilled by a separate data
-- migration, and the router treats NULL as the primary region.
ALTER TABLE "workspaces" ADD COLUMN "homeRegion" TEXT;

CREATE INDEX "workspaces_homeRegion_idx" ON "workspaces"("homeRegion");
