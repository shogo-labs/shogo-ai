-- Local (SQLite) mirror of the cloud Durable-git changes:
--   1. `Project.cloudSyncMode` default flips s3 -> git_only.
--   2. Two new nullable columns: `publishedCommitSha`, `publishedTag`.
-- See prisma/migrations/20260603000000_default_git_only_and_publish_commit
-- for the PG-side form. SQLite cannot ALTER a column default in place, so
-- we rebuild the `projects` table (Prisma's standard 12-step redefine).
-- Cloud sync is a no-op on desktop (SHOGO_LOCAL_MODE), so the default
-- value change is purely for schema parity; the new columns are additive.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workspaceId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'starter',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "schemas" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "folderId" TEXT,
    "publishedSubdomain" TEXT,
    "publishedAt" DATETIME,
    "publishStatus" TEXT NOT NULL DEFAULT 'idle',
    "publishError" TEXT,
    "publishStatusAt" DATETIME,
    "publishedCommitSha" TEXT,
    "publishedTag" TEXT,
    "accessLevel" TEXT NOT NULL DEFAULT 'anyone',
    "category" TEXT,
    "siteTitle" TEXT,
    "siteDescription" TEXT,
    "thumbnailUrl" TEXT,
    "templateId" TEXT,
    "knativeServiceName" TEXT,
    "settings" TEXT,
    "lastMessageAt" DATETIME,
    "workingMode" TEXT NOT NULL DEFAULT 'managed',
    "runtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trustLevel" TEXT NOT NULL DEFAULT 'trusted',
    "preferredInstanceId" TEXT,
    "preferredInstancePolicy" TEXT NOT NULL DEFAULT 'pinned',
    "cloudSyncMode" TEXT NOT NULL DEFAULT 'git_only',
    CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "projects_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "projects_preferredInstanceId_fkey" FOREIGN KEY ("preferredInstanceId") REFERENCES "instances" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_projects" ("accessLevel", "category", "cloudSyncMode", "createdAt", "createdBy", "description", "folderId", "id", "knativeServiceName", "lastMessageAt", "name", "preferredInstanceId", "preferredInstancePolicy", "publishError", "publishStatus", "publishStatusAt", "publishedAt", "publishedSubdomain", "runtimeEnabled", "schemas", "settings", "siteDescription", "siteTitle", "status", "templateId", "thumbnailUrl", "tier", "trustLevel", "updatedAt", "workingMode", "workspaceId") SELECT "accessLevel", "category", "cloudSyncMode", "createdAt", "createdBy", "description", "folderId", "id", "knativeServiceName", "lastMessageAt", "name", "preferredInstanceId", "preferredInstancePolicy", "publishError", "publishStatus", "publishStatusAt", "publishedAt", "publishedSubdomain", "runtimeEnabled", "schemas", "settings", "siteDescription", "siteTitle", "status", "templateId", "thumbnailUrl", "tier", "trustLevel", "updatedAt", "workingMode", "workspaceId" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
CREATE UNIQUE INDEX "projects_publishedSubdomain_key" ON "projects"("publishedSubdomain");
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");
CREATE INDEX "projects_folderId_idx" ON "projects"("folderId");
CREATE INDEX "projects_preferredInstanceId_idx" ON "projects"("preferredInstanceId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
