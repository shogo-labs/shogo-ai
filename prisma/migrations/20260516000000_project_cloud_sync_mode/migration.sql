-- Add a per-project cloud sync strategy so we can phase in git-based
-- per-turn sync alongside the existing S3 tarball path WITHOUT a
-- big-bang flag day. See apps/docs/docs/architecture/cloud-pod-sync.md
-- for the three-mode lifecycle and rollout playbook.
--
-- Modes:
--   - 's3'          (default) — today's behavior. Every existing row
--                   gets this implicitly; no behavioral change.
--   - 'dual_shadow' — verification. Cloud pod runs both S3Sync AND
--                   GitWorkspaceSync. Used to compare git-side vs
--                   S3-side checkpoints before flipping a project to
--                   git_only.
--   - 'git_only'    — git is the primary writer; S3 Layer 2 stays
--                   suppressed but is re-enabled at runtime as a
--                   fallback if pushes start failing.
--
-- Additive + defaulted -> zero downtime, no application changes for
-- rows that don't opt in.

CREATE TYPE "CloudSyncMode" AS ENUM ('s3', 'dual_shadow', 'git_only');

ALTER TABLE "projects"
  ADD COLUMN "cloudSyncMode" "CloudSyncMode" NOT NULL DEFAULT 's3';
