-- Durable cloud git: default projects to `git_only` + record the published commit.
--
-- Part 1 — flip the cloudSyncMode default to `git_only` and backfill.
--   Pod-owned model: the runtime pod owns the repo and persists its own
--   `.git` to object storage (packages/shared-runtime/src/repo-store.ts);
--   the API hydrates it on demand to serve reads. S3 Layer 2 stays armed
--   as an automatic fallback. Legacy `s3` projects are migrated to
--   `git_only` and seed their durable repo on the next cold start
--   (seedRepoIfAbsent → persistRepoToStore in repo-store.ts).
--
--   NOTE (rollout): this is the final "flip the default" step from the
--   cloud-pod-sync rollout playbook. It must ship together with the
--   pod-side durable store (persist/restore/seed) + local-only commit +
--   checkpoint recording + large-file offload + the API hydrate-only
--   read-guard so every git_only project has a working durable path.
--   `dual_shadow` projects are left untouched.
--
-- Part 2 — add the published commit/tag anchor columns. Both additive +
--   nullable, so zero downtime.

ALTER TABLE "projects"
  ALTER COLUMN "cloudSyncMode" SET DEFAULT 'git_only';

UPDATE "projects"
  SET "cloudSyncMode" = 'git_only'
  WHERE "cloudSyncMode" = 's3';

ALTER TABLE "projects"
  ADD COLUMN "publishedCommitSha" TEXT,
  ADD COLUMN "publishedTag"       TEXT;
