-- Migration: add_workspace_chat_sessions
-- Source:    prisma/schema.local.prisma
--
-- Adds workspace-scoped chat support to the desktop SQLite track:
--   * chat_sessions.workspaceId column + FK to workspaces + index
--   * chat_session_projects join table (attached projects per session)
--
-- Hand-trimmed from `prisma migrate diff --from-migrations
-- apps/desktop/prisma/migrations --to-schema prisma/schema.local.prisma`
-- to include ONLY the two tables this feature touches; the unrelated
-- accepted-drift tables (see scripts/check-desktop-schema-drift.ts
-- allow-list) are intentionally left untouched.

-- Recover from a half-applied / poisoned state. Earlier app versions ran a
-- "schema rescue" sweep on every launch that resurrected RedefineTables temp
-- tables (e.g. "new_chat_sessions") as empty orphans, and a first attempt at
-- this migration could leave "chat_session_projects" behind after failing on
-- the orphaned "new_chat_sessions". Both tables are owned exclusively by this
-- migration (or are transient), so dropping any stale copy first makes the
-- migration safe to retry without manual DB surgery.
DROP TABLE IF EXISTS "chat_session_projects";

-- CreateTable
CREATE TABLE "chat_session_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "attachMode" TEXT NOT NULL DEFAULT 'readwrite',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_session_projects_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chat_session_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS "new_chat_sessions";
CREATE TABLE "new_chat_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "inferredName" TEXT NOT NULL,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT,
    "workspaceId" TEXT,
    "phase" TEXT,
    "claudeCodeSessionId" TEXT,
    "cachedMessageCount" INTEGER NOT NULL DEFAULT 0,
    "contextUsageTokens" INTEGER NOT NULL DEFAULT 0,
    "contextWindowTokens" INTEGER NOT NULL DEFAULT 0,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_sessions_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chat_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_chat_sessions" ("cachedMessageCount", "claudeCodeSessionId", "contextId", "contextType", "contextUsageTokens", "contextWindowTokens", "createdAt", "id", "inferredName", "isArchived", "isPinned", "lastActiveAt", "name", "phase", "updatedAt") SELECT "cachedMessageCount", "claudeCodeSessionId", "contextId", "contextType", "contextUsageTokens", "contextWindowTokens", "createdAt", "id", "inferredName", "isArchived", "isPinned", "lastActiveAt", "name", "phase", "updatedAt" FROM "chat_sessions";
DROP TABLE "chat_sessions";
ALTER TABLE "new_chat_sessions" RENAME TO "chat_sessions";
CREATE INDEX "chat_sessions_contextType_contextId_idx" ON "chat_sessions"("contextType", "contextId");
CREATE INDEX "chat_sessions_workspaceId_idx" ON "chat_sessions"("workspaceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "chat_session_projects_projectId_idx" ON "chat_session_projects"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_session_projects_sessionId_projectId_key" ON "chat_session_projects"("sessionId", "projectId");
