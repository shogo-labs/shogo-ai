-- Migration: Project bucket (SHO-491)
--
-- Adds the index for a project's Shogo-hosted object storage. Bytes live in
-- S3_PROJECT_BUCKET under `p/<projectId>/<visibility>/<key>`; this table is
-- what the bucket API lists, the storage meter counts under `bucket`, and the
-- upload gate reads between measurement passes. Additive only.

-- CreateTable
CREATE TABLE "project_bucket_objects" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "size" BIGINT NOT NULL DEFAULT 0,
    "contentType" TEXT,
    "etag" TEXT,
    "sha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_bucket_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_bucket_objects_projectId_visibility_key_key" ON "project_bucket_objects"("projectId", "visibility", "key");

-- CreateIndex
CREATE INDEX "project_bucket_objects_projectId_idx" ON "project_bucket_objects"("projectId");

-- CreateIndex
CREATE INDEX "project_bucket_objects_createdAt_idx" ON "project_bucket_objects"("createdAt");

-- AddForeignKey
ALTER TABLE "project_bucket_objects" ADD CONSTRAINT "project_bucket_objects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
