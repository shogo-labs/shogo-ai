-- Migration: add_model_definitions_and_providers
-- Generated: 2026-05-29 by scripts/db-migrate-desktop.ts (trimmed to scope)
-- Source:    prisma/schema.local.prisma
--
-- Only the two new tables for the DB-defined model catalog are included.
-- The full `prisma migrate diff` also surfaced redefinitions of several
-- pre-existing ACCEPTED_DRIFT tables (agent_configs, projects, usage_wallets,
-- etc. — see scripts/check-desktop-schema-drift.ts). Those are tracked tech
-- debt and intentionally left out of this migration so it stays scoped to the
-- model-catalog change.

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "authStyle" TEXT NOT NULL DEFAULT 'bearer',
    "encryptedApiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "model_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "providerId" TEXT,
    "apiModel" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "shortDisplayName" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "family" TEXT NOT NULL DEFAULT 'other',
    "generation" TEXT NOT NULL DEFAULT 'current',
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 64000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER,
    "aliases" TEXT,
    "capabilities" TEXT,
    "inputPerMillion" REAL NOT NULL DEFAULT 0,
    "cachedInputPerMillion" REAL NOT NULL DEFAULT 0,
    "cacheWritePerMillion" REAL NOT NULL DEFAULT 0,
    "outputPerMillion" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "model_definitions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_providers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "model_definitions_providerId_idx" ON "model_definitions"("providerId");
