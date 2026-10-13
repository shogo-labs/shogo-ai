-- CreateTable
CREATE TABLE "conversation_docs" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "updatedByType" TEXT NOT NULL DEFAULT 'user',
    "updatedByUserId" TEXT,
    "updatedByProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_doc_revisions" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "updatedByType" TEXT NOT NULL DEFAULT 'user',
    "updatedByUserId" TEXT,
    "updatedByProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_doc_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_docs_conversationId_key" ON "conversation_docs"("conversationId");

-- CreateIndex
CREATE INDEX "conversation_docs_workspaceId_idx" ON "conversation_docs"("workspaceId");

-- CreateIndex
CREATE INDEX "conversation_doc_revisions_docId_createdAt_idx" ON "conversation_doc_revisions"("docId", "createdAt");

-- AddForeignKey
ALTER TABLE "conversation_docs" ADD CONSTRAINT "conversation_docs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_doc_revisions" ADD CONSTRAINT "conversation_doc_revisions_docId_fkey" FOREIGN KEY ("docId") REFERENCES "conversation_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
