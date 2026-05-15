-- External-trigger routing: persist "which environment owns this project"
-- so /api/projects/:id/agent-proxy/* can transparently route to a paired
-- Instance via the tunnel, giving users ONE stable URL per project.
--
-- See:
--   apps/api/src/lib/agent-proxy-resolver.ts for the resolution order
--   apps/docs/docs/features/external-triggers/quickstart.md for the user story
--
-- Both columns are additive + defaulted -- zero downtime, identical
-- behavior to today for any row that doesn't opt in.
--
-- `preferredInstancePolicy` is a free-form string (not an enum) to match
-- the existing pattern on the Project model (`workingMode`, `trustLevel`).
-- Allowed values today: 'pinned' (default — 503 if VPS offline) and
-- 'prefer' (fall back to a cloud pod).

PRAGMA foreign_keys = OFF;

ALTER TABLE "projects" ADD COLUMN "preferredInstanceId" TEXT;
ALTER TABLE "projects" ADD COLUMN "preferredInstancePolicy" TEXT NOT NULL DEFAULT 'pinned';

CREATE INDEX "projects_preferredInstanceId_idx" ON "projects"("preferredInstanceId");

PRAGMA foreign_keys = ON;
