-- Migration: DB-defined model catalog (super-admin managed) + custom providers.
--
-- See prisma/schema.prisma `ModelProvider` and `ModelDefinition` for the
-- canonical comments. Custom OpenAI-compatible providers (e.g. MiMo) store
-- their API key encrypted-at-rest (apps/api/src/lib/secret-crypto.ts).

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "authStyle" TEXT NOT NULL DEFAULT 'bearer',
    "encryptedApiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_definitions" (
    "id" TEXT NOT NULL,
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
    "aliases" JSONB,
    "capabilities" JSONB,
    "inputPerMillion" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cachedInputPerMillion" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cacheWritePerMillion" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outputPerMillion" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "model_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_definitions_providerId_idx" ON "model_definitions"("providerId");

-- AddForeignKey
ALTER TABLE "model_definitions" ADD CONSTRAINT "model_definitions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
