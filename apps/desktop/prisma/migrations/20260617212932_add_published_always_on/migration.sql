-- Always-on published apps: when true, the published Knative service runs at
-- min-scale=1 (never scales to zero) so visitors never hit a cold start.
-- Gated by plan/seat allotment (see apps/api/src/services/billing.service.ts
-- canEnableAlwaysOn + apps/api/src/routes/publish.ts).
--
-- Additive + defaulted -- zero downtime, identical behavior to today for any
-- row that doesn't opt in.

PRAGMA foreign_keys = OFF;

ALTER TABLE "projects" ADD COLUMN "publishedAlwaysOn" BOOLEAN NOT NULL DEFAULT false;

PRAGMA foreign_keys = ON;
