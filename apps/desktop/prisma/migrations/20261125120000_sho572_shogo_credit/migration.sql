-- Migration: Shogo credit (SHO-572), SQLite/desktop track.
--
-- Mirrors prisma/migrations/20261125120000_sho572_shogo_credit. Desktop never
-- spends credit (billing returns early in local mode) but the table and its
-- migration ship on both tracks — see the schema-parity rule in the channel
-- doc. The data migration is the same balance-to-grant copy so a database that
-- moved between surfaces keeps its credit.

-- CreateTable
CREATE TABLE "shogo_credit_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "amountUsd" REAL NOT NULL,
    "remainingUsd" REAL NOT NULL,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shogo_credit_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "shogo_credit_grants_source_sourceRef_key" ON "shogo_credit_grants"("source", "sourceRef");

-- CreateIndex
CREATE INDEX "shogo_credit_grants_workspaceId_expiresAt_idx" ON "shogo_credit_grants"("workspaceId", "expiresAt");

-- DataMigration: every unexpired signup balance becomes one `signup` grant.
-- Desktop is a single writer per machine (no logical replication, so no
-- SHO-344 shape), and the id is random — the published-track copy lives in
-- scripts/backfill-shogo-credit-grants.ts instead.
INSERT INTO "shogo_credit_grants" (
    "id",
    "workspaceId",
    "source",
    "sourceRef",
    "amountUsd",
    "remainingUsd",
    "expiresAt",
    "createdAt"
)
SELECT
    lower(hex(randomblob(16))),
    w."workspaceId",
    'signup',
    'signup:' || w."workspaceId" || ':migrated',
    w."promoCreditUsd",
    w."promoCreditUsd",
    w."promoCreditExpiresAt",
    CURRENT_TIMESTAMP
FROM "usage_wallets" w
WHERE w."promoCreditUsd" > 0
  AND w."promoCreditExpiresAt" IS NOT NULL
  AND w."promoCreditExpiresAt" > CURRENT_TIMESTAMP;
