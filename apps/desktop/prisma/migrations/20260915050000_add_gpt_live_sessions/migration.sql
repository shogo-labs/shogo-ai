-- Migration: add_gpt_live_sessions
-- Source: prisma/schema.local.prisma
--
-- GPT-Live session duration is metered separately from chat token usage.

-- AlterTable
ALTER TABLE "model_definitions" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "model_definitions" ADD COLUMN "usdPerMinute" REAL;

-- CreateTable
CREATE TABLE "live_session_meters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "memberId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "backendModel" TEXT,
    "transport" TEXT NOT NULL,
    "seconds" REAL NOT NULL DEFAULT 0,
    "rawUsd" REAL NOT NULL DEFAULT 0,
    "billedUsd" REAL NOT NULL DEFAULT 0,
    "usageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "live_session_meters_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "live_session_meters_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "projects" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "live_session_meters_sessionId_key"
  ON "live_session_meters"("sessionId");
CREATE INDEX "live_session_meters_workspaceId_idx"
  ON "live_session_meters"("workspaceId");
CREATE INDEX "live_session_meters_projectId_idx"
  ON "live_session_meters"("projectId");
