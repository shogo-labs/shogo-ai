-- SQLite mirror of prisma/migrations/20261104120000_sho308_published_environments
-- (SHO-308). Published apps run on Knative in one or more environments; the
-- desktop keeps the same models so both schemas stay one model.

CREATE TABLE "published_environments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "minReplicas" INTEGER NOT NULL DEFAULT 0,
    "maxReplicas" INTEGER NOT NULL DEFAULT 1,
    "size" TEXT NOT NULL DEFAULT 's',
    "dbProvider" TEXT,
    "dbName" TEXT,
    "currentDeploymentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "published_environments_subdomain_key" ON "published_environments"("subdomain");
CREATE UNIQUE INDEX "published_environments_projectId_name_key" ON "published_environments"("projectId", "name");
CREATE INDEX "published_environments_projectId_idx" ON "published_environments"("projectId");

CREATE TABLE "published_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "imageDigest" TEXT,
    "schemaHash" TEXT,
    "revisionName" TEXT,
    "promotedFromId" TEXT,
    "createdBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "published_deployments_environmentId_createdAt_idx" ON "published_deployments"("environmentId", "createdAt");

CREATE TABLE "published_usage_minutes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "minute" DATETIME NOT NULL,
    "podSeconds" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors5xx" INTEGER NOT NULL DEFAULT 0,
    "p95Ms" INTEGER,
    "egressBytes" BIGINT NOT NULL DEFAULT 0,
    "dbStorageBytes" BIGINT NOT NULL DEFAULT 0,
    "billedAt" DATETIME
);

CREATE UNIQUE INDEX "published_usage_minutes_environmentId_minute_key" ON "published_usage_minutes"("environmentId", "minute");
CREATE INDEX "published_usage_minutes_billedAt_idx" ON "published_usage_minutes"("billedAt");

INSERT INTO "published_environments" ("id", "projectId", "name", "subdomain", "minReplicas", "maxReplicas", "size", "createdAt", "updatedAt")
SELECT
    'penv_' || "id",
    "id",
    'production',
    "publishedSubdomain",
    CASE WHEN "publishedAlwaysOn" THEN 1 ELSE 0 END,
    1,
    's',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "projects"
WHERE "publishedSubdomain" IS NOT NULL
ON CONFLICT DO NOTHING;
