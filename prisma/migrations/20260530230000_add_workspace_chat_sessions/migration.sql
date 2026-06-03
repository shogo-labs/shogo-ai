-- AlterEnum
ALTER TYPE "ContextType" ADD VALUE 'workspace';

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "workspaceId" TEXT;

-- CreateTable
CREATE TABLE "chat_session_projects" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "attachMode" TEXT NOT NULL DEFAULT 'readwrite',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_session_projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_session_projects_projectId_idx" ON "chat_session_projects"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_session_projects_sessionId_projectId_key" ON "chat_session_projects"("sessionId", "projectId");

-- CreateIndex
CREATE INDEX "chat_sessions_workspaceId_idx" ON "chat_sessions"("workspaceId");

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_session_projects" ADD CONSTRAINT "chat_session_projects_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_session_projects" ADD CONSTRAINT "chat_session_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
