-- Migration: add_conversation_doc_archives
-- Generated: 2026-10-19T19:00:00.000Z (hand-written, mirrors
--            prisma/migrations/20261019190000_add_conversation_doc_archives)
-- Source:    prisma/schema.local.prisma
--
-- Sections archived out of a channel doc (SHO-62). SQLite inlines the FK into
-- CREATE TABLE, matching what `prisma migrate diff` emits.

-- CreateTable
CREATE TABLE "conversation_doc_archives" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "heading" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "chars" INTEGER NOT NULL DEFAULT 0,
    "archivedByType" TEXT NOT NULL DEFAULT 'user',
    "archivedByUserId" TEXT,
    "archivedByProjectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_doc_archives_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "conversation_doc_archives_conversationId_createdAt_idx" ON "conversation_doc_archives"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_doc_archives_workspaceId_idx" ON "conversation_doc_archives"("workspaceId");
