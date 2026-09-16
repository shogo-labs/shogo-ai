CREATE TABLE "plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT,
  "projectId" TEXT,
  "chatSessionId" TEXT,
  "runtimeKey" TEXT,
  "filename" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "overview" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "content" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  CONSTRAINT "plans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE,
  CONSTRAINT "plans_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions" ("id") ON DELETE SET NULL
);
CREATE INDEX "plans_workspaceId_idx" ON "plans"("workspaceId");
CREATE INDEX "plans_projectId_idx" ON "plans"("projectId");
CREATE INDEX "plans_chatSessionId_idx" ON "plans"("chatSessionId");
CREATE INDEX "plans_updatedAt_idx" ON "plans"("updatedAt");
CREATE UNIQUE INDEX "plans_projectId_filename_key" ON "plans"("projectId", "filename");

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT,
  "projectId" TEXT,
  "chatSessionId" TEXT,
  "runtimeKey" TEXT,
  "filename" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "overview" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "content" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "plans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "plans_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_plans" ("chatSessionId", "content", "createdAt", "filename", "id", "name", "overview", "projectId", "runtimeKey", "status", "updatedAt", "workspaceId")
  SELECT "chatSessionId", "content", "createdAt", "filename", "id", "name", "overview", "projectId", "runtimeKey", "status", "updatedAt", "workspaceId" FROM "plans";
DROP TABLE "plans";
ALTER TABLE "new_plans" RENAME TO "plans";
CREATE INDEX "plans_workspaceId_idx" ON "plans"("workspaceId");
CREATE INDEX "plans_projectId_idx" ON "plans"("projectId");
CREATE INDEX "plans_chatSessionId_idx" ON "plans"("chatSessionId");
CREATE INDEX "plans_updatedAt_idx" ON "plans"("updatedAt");
CREATE UNIQUE INDEX "plans_projectId_filename_key" ON "plans"("projectId", "filename");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
