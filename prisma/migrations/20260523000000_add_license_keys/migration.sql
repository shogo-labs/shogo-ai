-- Migration: add LicenseKey for single-use coupons that promote a
-- workspace to a paid plan tier by minting a WorkspaceGrant on
-- redemption. Issuance and redemption are decoupled so we can
-- pre-mint batches, expire unredeemed keys, and audit who redeemed
-- what.
--
-- Only `codeHash` (sha-256 hex of the canonical plaintext) is stored;
-- the plaintext is shown to the recipient once at issuance and is
-- never persisted. `codePrefix` is the first 12 plaintext chars for
-- admin lookup / CSV reconciliation.
--
-- Atomic single-use redemption is enforced by:
--   1. `updateMany({ where: { codeHash, redeemedAt: NULL } })` in the
--      service, which serializes concurrent redemptions via row lock.
--   2. UNIQUE constraints on `redeemedByWorkspaceId` and
--      `redeemedGrantId` as a defense-in-depth backstop.

CREATE TABLE "license_keys" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "batchId" TEXT,
    "planId" TEXT NOT NULL,
    "monthlyIncludedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "freeSeats" INTEGER NOT NULL DEFAULT 0,
    "durationDays" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedByWorkspaceId" TEXT,
    "redeemedByUserId" TEXT,
    "redeemedGrantId" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "license_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "license_keys_codeHash_key" ON "license_keys"("codeHash");
CREATE UNIQUE INDEX "license_keys_redeemedByWorkspaceId_key" ON "license_keys"("redeemedByWorkspaceId");
CREATE UNIQUE INDEX "license_keys_redeemedGrantId_key" ON "license_keys"("redeemedGrantId");
CREATE INDEX "license_keys_batchId_idx" ON "license_keys"("batchId");
CREATE INDEX "license_keys_redeemedAt_idx" ON "license_keys"("redeemedAt");

ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_redeemedGrantId_fkey" FOREIGN KEY ("redeemedGrantId") REFERENCES "workspace_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
