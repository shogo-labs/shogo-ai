-- Migration: Native release (SHO-323).
--
-- Shipping an Expo project to the App Store / Google Play. Six tables: the app
-- mapping, the customer's encrypted store/Expo credentials, the signing
-- material we generate or accept, one row per release, one per EAS build, and
-- the monthly Updates-MAU claim row.
--
-- There is deliberately no `ExpoOrg` table: Russell's 2026-11-06 decision is one
-- Shogo Expo account holding every project, with the token confined to the API
-- process. See docs/native-release/eas-graphql.md for why a per-workspace
-- organisation cannot exist (the public GraphQL API has no mutation to create
-- one).
--
-- `native_releases.platforms` is the only list column; the desktop track stores
-- it as JSON-encoded TEXT in apps/desktop/prisma/migrations.

-- CreateTable
CREATE TABLE "native_apps" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'byok',
    "easAccountId" TEXT,
    "easAppId" TEXT,
    "bundleIdentifier" TEXT,
    "androidPackage" TEXT,
    "ascAppId" TEXT,
    "idsLockedAt" TIMESTAMP(3),
    "firstPlaySubmissionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_app_credentials" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "maskedHint" TEXT NOT NULL,
    "validatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_app_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_signing_credentials" (
    "id" TEXT NOT NULL,
    "nativeAppId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "appleResourceId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'generated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_signing_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_releases" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "track" TEXT NOT NULL DEFAULT 'internal',
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" TEXT,
    "error" TEXT,
    "sourceBucketKey" TEXT,
    "workflowRunId" TEXT,
    "testOutcome" TEXT,
    "testMeteredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_builds" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "easBuildId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "resourceClass" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "artifactKey" TEXT,
    "submissionId" TEXT,
    "submissionStatus" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "meteredAt" TIMESTAMP(3),
    "meterStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_builds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_usage_months" (
    "id" TEXT NOT NULL,
    "nativeAppId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "mau" INTEGER NOT NULL DEFAULT 0,
    "meteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_usage_months_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "native_apps_projectId_key" ON "native_apps"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "native_apps_easAppId_key" ON "native_apps"("easAppId");

-- CreateIndex
CREATE INDEX "native_apps_workspaceId_idx" ON "native_apps"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "native_app_credentials_workspaceId_kind_key" ON "native_app_credentials"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "native_signing_credentials_nativeAppId_platform_kind_idx" ON "native_signing_credentials"("nativeAppId", "platform", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "native_releases_workflowRunId_key" ON "native_releases"("workflowRunId");

-- CreateIndex
CREATE INDEX "native_releases_projectId_createdAt_idx" ON "native_releases"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "native_releases_workspaceId_status_idx" ON "native_releases"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "native_releases_status_updatedAt_idx" ON "native_releases"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "native_builds_easBuildId_key" ON "native_builds"("easBuildId");

-- CreateIndex
CREATE INDEX "native_builds_releaseId_purpose_idx" ON "native_builds"("releaseId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "native_usage_months_nativeAppId_month_key" ON "native_usage_months"("nativeAppId", "month");

-- AddForeignKey
ALTER TABLE "native_apps" ADD CONSTRAINT "native_apps_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_apps" ADD CONSTRAINT "native_apps_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_app_credentials" ADD CONSTRAINT "native_app_credentials_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_signing_credentials" ADD CONSTRAINT "native_signing_credentials_nativeAppId_fkey" FOREIGN KEY ("nativeAppId") REFERENCES "native_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_releases" ADD CONSTRAINT "native_releases_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_builds" ADD CONSTRAINT "native_builds_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "native_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_usage_months" ADD CONSTRAINT "native_usage_months_nativeAppId_fkey" FOREIGN KEY ("nativeAppId") REFERENCES "native_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
