-- Migration: Add WorkspaceGrant for super-admin-managed credit grants.
-- Each row gives a workspace a fixed number of free seats (deducted
-- from the Stripe seat quantity, with a minimum of 1 paid seat) and a
-- monthly USD allotment that stacks on top of any plan-included USD.

CREATE TABLE "workspace_grants" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "freeSeats" INTEGER NOT NULL DEFAULT 0,
    "monthlyIncludedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_grants_workspaceId_expiresAt_idx" ON "workspace_grants"("workspaceId", "expiresAt");

ALTER TABLE "workspace_grants" ADD CONSTRAINT "workspace_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
