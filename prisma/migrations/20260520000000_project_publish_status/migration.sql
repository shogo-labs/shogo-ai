-- Track publish-pipeline progress per-project so a stuck or cancelled
-- HTTP request to /api/projects/:id/publish leaves a recoverable trail
-- in the DB instead of forcing operators to scrape pod logs.
--
-- Until now `publishedAt` was the only signal — and it only flipped on
-- the final success step. The b11c65dd-... 2026-05-20 incident showed
-- a publish that completed step 1 (build), froze in step 2 (download
-- dist files from a frozen runtime), got cancelled by Knative scaling
-- the project ksvc to zero, and never wrote anything observable.
--
-- States (mirrors PublishStatus enum in schema.prisma):
--   idle         — never published or after unpublish
--   building     — POST /preview/restart in flight on the runtime pod
--   uploading    — dist files being uploaded to S3
--   configuring  — published-{id} ksvc + DomainMapping being created
--   live         — terminal success
--   failed       — terminal failure; publishError carries the code
--
-- All three columns are additive and defaulted -> zero downtime.

CREATE TYPE "PublishStatus" AS ENUM ('idle', 'building', 'uploading', 'configuring', 'live', 'failed');

ALTER TABLE "projects"
  ADD COLUMN "publishStatus"   "PublishStatus" NOT NULL DEFAULT 'idle',
  ADD COLUMN "publishError"    TEXT,
  ADD COLUMN "publishStatusAt" TIMESTAMP(3);
