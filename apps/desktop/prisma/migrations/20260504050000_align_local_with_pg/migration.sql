-- Align prisma/schema.local.prisma with prisma/schema.prisma.
--
-- Drift accumulated from prior PG-only changes that were never mirrored
-- to the SQLite side. Each block below corresponds to a separate PG
-- migration that should have had a SQLite counterpart at the time.
--
-- See scripts/check-schema-parity.ts which now runs in pre-commit and
-- prevents this kind of drift going forward.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. SignupAttribution — mirrors prisma/migrations/20260323_add_analytics_digests_and_signup_attributions
--    (sourceTag column was added later but is included here in the catch-up
--    table since the PG model now has it.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "signup_attributions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,
  "utmTerm" TEXT,
  "referrer" TEXT,
  "landingPage" TEXT,
  "signupMethod" TEXT,
  "sourceTag" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signup_attributions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "signup_attributions_sourceTag_idx"
  ON "signup_attributions"("sourceTag");
CREATE INDEX IF NOT EXISTS "signup_attributions_createdAt_idx"
  ON "signup_attributions"("createdAt");

-- ---------------------------------------------------------------------------
-- 2. Drop projects.type — mirrors prisma/migrations/20260331110344_cleanup_schema_drift
--    PG dropped this column on Mar 31, 2026 but local kept it. No code
--    reads `project.type` from the DB anymore (verified).
-- ---------------------------------------------------------------------------

ALTER TABLE "projects" DROP COLUMN "type";

-- ---------------------------------------------------------------------------
-- 3. usage_wallets.overageBilledUsd — mirrors prisma/migrations/20260429210000_add_overage_billed_trust
--    Tracks how much of accumulated overage has already been invoiced
--    this period. Resets each monthly allocation.
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_wallets"
  ADD COLUMN "overageBilledUsd" REAL NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. eval_runs.tags — backfill NULL → '[]' so the column can be treated
--    as `String @default("[]")` (JSON-array-as-string convention) in
--    schema.local.prisma. The SQLite column stays nullable at the DB
--    level (SQLite can't change NOT NULL without a table rebuild), but
--    Prisma will refuse to insert NULLs going forward and the schema
--    default backs all new inserts with '[]'.
-- ---------------------------------------------------------------------------

UPDATE "eval_runs" SET "tags" = '[]' WHERE "tags" IS NULL;
