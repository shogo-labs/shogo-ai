ALTER TABLE "agent_tasks" ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE "note_folders" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "parentId" TEXT,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "note_folders_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "notes" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "folderId" TEXT,
  "title" TEXT NOT NULL DEFAULT '',
  "contentJson" JSONB NOT NULL,
  "plainText" TEXT NOT NULL DEFAULT '',
  "preview" TEXT NOT NULL DEFAULT '',
  "isPinned" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "note_assets" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "noteId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "transcriptionStatus" TEXT NOT NULL DEFAULT 'not_applicable',
  "transcriptText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "note_assets_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "note_task_snapshots" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "noteId" TEXT,
  "sourceVersion" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "contentJson" JSONB NOT NULL,
  "plainText" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "note_task_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "note_transcription_jobs" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "note_transcription_jobs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "note_task_snapshot_assets" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "assetId" TEXT,
  "storageKey" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  CONSTRAINT "note_task_snapshot_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "note_task_snapshots_taskId_key" ON "note_task_snapshots"("taskId");
CREATE UNIQUE INDEX "note_transcription_jobs_assetId_key" ON "note_transcription_jobs"("assetId");
CREATE UNIQUE INDEX "note_task_snapshots_idempotencyKey_key" ON "note_task_snapshots"("idempotencyKey");
CREATE UNIQUE INDEX "note_task_snapshot_assets_snapshotId_assetId_key" ON "note_task_snapshot_assets"("snapshotId", "assetId");
CREATE INDEX "note_folders_workspaceId_ownerId_idx" ON "note_folders"("workspaceId", "ownerId");
CREATE INDEX "note_folders_ownerId_parentId_idx" ON "note_folders"("ownerId", "parentId");
CREATE INDEX "note_folders_ownerId_updatedAt_idx" ON "note_folders"("ownerId", "updatedAt");
CREATE INDEX "notes_workspaceId_ownerId_deletedAt_idx" ON "notes"("workspaceId", "ownerId", "deletedAt");
CREATE INDEX "notes_ownerId_folderId_updatedAt_idx" ON "notes"("ownerId", "folderId", "updatedAt");
CREATE INDEX "notes_ownerId_isPinned_updatedAt_idx" ON "notes"("ownerId", "isPinned", "updatedAt");
CREATE INDEX "note_assets_workspaceId_ownerId_idx" ON "note_assets"("workspaceId", "ownerId");
CREATE INDEX "note_assets_noteId_deletedAt_idx" ON "note_assets"("noteId", "deletedAt");
CREATE INDEX "note_assets_ownerId_updatedAt_idx" ON "note_assets"("ownerId", "updatedAt");
CREATE INDEX "note_task_snapshots_noteId_createdAt_idx" ON "note_task_snapshots"("noteId", "createdAt");
CREATE INDEX "note_task_snapshot_assets_assetId_idx" ON "note_task_snapshot_assets"("assetId");
CREATE INDEX "note_transcription_jobs_workspaceId_status_nextRetryAt_idx" ON "note_transcription_jobs"("workspaceId", "status", "nextRetryAt");
CREATE INDEX "note_transcription_jobs_assetId_status_idx" ON "note_transcription_jobs"("assetId", "status");

ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "note_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "note_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "note_assets" ADD CONSTRAINT "note_assets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_assets" ADD CONSTRAINT "note_assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_assets" ADD CONSTRAINT "note_assets_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_task_snapshots" ADD CONSTRAINT "note_task_snapshots_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_task_snapshots" ADD CONSTRAINT "note_task_snapshots_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "note_task_snapshot_assets" ADD CONSTRAINT "note_task_snapshot_assets_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "note_task_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_task_snapshot_assets" ADD CONSTRAINT "note_task_snapshot_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "note_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "note_transcription_jobs" ADD CONSTRAINT "note_transcription_jobs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "note_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_transcription_jobs" ADD CONSTRAINT "note_transcription_jobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
