CREATE TABLE "plans" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "projectId" TEXT,
  "chatSessionId" TEXT,
  "runtimeKey" TEXT,
  "filename" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "overview" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "plans_workspaceId_idx" ON "plans"("workspaceId");
CREATE INDEX "plans_projectId_idx" ON "plans"("projectId");
CREATE INDEX "plans_chatSessionId_idx" ON "plans"("chatSessionId");
CREATE INDEX "plans_updatedAt_idx" ON "plans"("updatedAt");
CREATE UNIQUE INDEX "plans_projectId_filename_key" ON "plans"("projectId", "filename");
ALTER TABLE "plans" ADD CONSTRAINT "plans_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plans" ADD CONSTRAINT "plans_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plans" ADD CONSTRAINT "plans_chatSessionId_fkey"
  FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
