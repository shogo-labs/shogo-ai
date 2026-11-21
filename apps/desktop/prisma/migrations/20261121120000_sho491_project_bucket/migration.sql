-- Migration: Project bucket (SHO-491)
-- Source:    prisma/schema.local.prisma
--
-- Desktop's filesystem-backed project bucket: one row per object under
-- <dataDir>/project-buckets/<projectId>/<visibility>/<key>. Additive only.

-- CreateTable
CREATE TABLE "project_bucket_objects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "size" BIGINT NOT NULL DEFAULT 0,
    "contentType" TEXT,
    "etag" TEXT,
    "sha256" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "project_bucket_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "project_bucket_objects_projectId_visibility_key_key" ON "project_bucket_objects"("projectId", "visibility", "key");

-- CreateIndex
CREATE INDEX "project_bucket_objects_projectId_idx" ON "project_bucket_objects"("projectId");

-- CreateIndex
CREATE INDEX "project_bucket_objects_createdAt_idx" ON "project_bucket_objects"("createdAt");
