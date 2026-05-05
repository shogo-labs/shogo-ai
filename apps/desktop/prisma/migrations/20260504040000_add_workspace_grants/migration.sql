-- Local SQLite migration: Add WorkspaceGrant for super-admin-managed
-- credit grants. Each row gives a workspace a fixed number of free
-- seats (deducted from the Stripe seat quantity, with a minimum of 1
-- paid seat) plus a monthly USD allotment that stacks on top of any
-- plan-included USD.
--
-- Mirrors prisma/migrations/20260504040000_add_workspace_grants/migration.sql.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "workspace_grants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "freeSeats" INTEGER NOT NULL DEFAULT 0,
  "monthlyIncludedUsd" REAL NOT NULL DEFAULT 0,
  "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME,
  "note" TEXT,
  "createdByUserId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_grants_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "workspace_grants_workspaceId_expiresAt_idx"
  ON "workspace_grants"("workspaceId", "expiresAt");
