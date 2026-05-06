-- Migration: add workspaces.composioScope to control whether Composio
-- OAuth connections are stored at the workspace level (one auth per
-- toolkit, shared across every project in the workspace) or remain
-- project-scoped (one auth per project, isolated).
--
-- Rollout:
--   * Schema default for the column is 'workspace' (new behavior).
--   * Existing workspaces are back-filled to 'project' so connections
--     authorized under the previous scoping continue to resolve without
--     forcing anyone to re-OAuth.
--
-- Lookup logic (apps/api/src/routes/integrations.ts and
-- packages/agent-runtime/src/composio.ts) does an asymmetric fallback:
-- workspace-scoped lookups also try the project-scoped + legacy IDs,
-- but project-scoped lookups never bleed in workspace-scoped IDs (so
-- the isolation guarantee for project scope is preserved).

ALTER TABLE "workspaces"
  ADD COLUMN "composioScope" TEXT NOT NULL DEFAULT 'workspace';

UPDATE "workspaces"
  SET "composioScope" = 'project'
  WHERE "createdAt" < NOW();
