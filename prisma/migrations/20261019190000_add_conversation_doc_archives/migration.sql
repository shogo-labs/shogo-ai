-- Sections archived out of a channel doc (SHO-62). Same model in
-- prisma/schema.local.prisma; the archive keeps the removed text so a doc can
-- be slimmed without losing it.
-- CreateTable
CREATE TABLE "conversation_doc_archives" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "heading" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "chars" INTEGER NOT NULL DEFAULT 0,
    "archivedByType" TEXT NOT NULL DEFAULT 'user',
    "archivedByUserId" TEXT,
    "archivedByProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_doc_archives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_doc_archives_conversationId_createdAt_idx" ON "conversation_doc_archives"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_doc_archives_workspaceId_idx" ON "conversation_doc_archives"("workspaceId");

-- AddForeignKey
ALTER TABLE "conversation_doc_archives" ADD CONSTRAINT "conversation_doc_archives_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
