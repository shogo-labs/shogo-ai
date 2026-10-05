-- AlterTable
ALTER TABLE "event_subscriptions" ADD COLUMN     "installId" TEXT,
ADD COLUMN     "ownerKind" TEXT NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "installId" TEXT,
ADD COLUMN     "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "marketplace_listing_versions" ADD COLUMN     "appManifest" JSONB;

-- CreateTable
CREATE TABLE "app_install_grants" (
    "id" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedToolkits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingVersion" TEXT,
    "encryptedToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_install_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_install_grants_installId_key" ON "app_install_grants"("installId");

-- CreateIndex
CREATE INDEX "app_install_grants_workspaceId_idx" ON "app_install_grants"("workspaceId");

-- CreateIndex
CREATE INDEX "event_subscriptions_installId_idx" ON "event_subscriptions"("installId");

-- CreateIndex
CREATE INDEX "api_keys_installId_idx" ON "api_keys"("installId");
