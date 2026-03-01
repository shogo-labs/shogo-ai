-- CreateTable: ProjectCheckpoint
-- Stores versioned snapshots of project state (git commits)
CREATE TABLE "project_checkpoints" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "includesDb" BOOLEAN NOT NULL DEFAULT false,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable: GitHubConnection
-- Links projects to GitHub repositories for sync
CREATE TABLE "github_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "installationId" INTEGER,
    "repoId" INTEGER,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPushAt" TIMESTAMP(3),
    "lastPullAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: ProjectCheckpoint indexes
CREATE INDEX "project_checkpoints_projectId_createdAt_idx" ON "project_checkpoints"("projectId", "createdAt" DESC);
CREATE INDEX "project_checkpoints_commitSha_idx" ON "project_checkpoints"("commitSha");

-- CreateIndex: GitHubConnection indexes
CREATE UNIQUE INDEX "github_connections_projectId_key" ON "github_connections"("projectId");
CREATE INDEX "github_connections_installationId_idx" ON "github_connections"("installationId");
CREATE INDEX "github_connections_repoFullName_idx" ON "github_connections"("repoFullName");

-- AddForeignKey: ProjectCheckpoint -> Project
ALTER TABLE "project_checkpoints" ADD CONSTRAINT "project_checkpoints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: GitHubConnection -> Project
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
