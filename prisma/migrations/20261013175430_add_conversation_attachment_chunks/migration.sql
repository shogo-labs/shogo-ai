-- CreateTable
CREATE TABLE "conversation_attachment_chunks" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "model" TEXT,
    "embedding" vector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_attachment_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_attachment_chunks_attachmentId_idx_idx" ON "conversation_attachment_chunks"("attachmentId", "idx");

-- CreateIndex
CREATE INDEX "conversation_attachment_chunks_conversationId_idx" ON "conversation_attachment_chunks"("conversationId");

-- CreateIndex
CREATE INDEX "conversation_attachment_chunks_workspaceId_createdAt_idx" ON "conversation_attachment_chunks"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "conversation_attachment_chunks" ADD CONSTRAINT "conversation_attachment_chunks_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "conversation_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Approximate nearest-neighbour index for 1536-dimension models, matching
-- conversation_message_embeddings. Prisma can't express HNSW or expression
-- indexes, so this is added by hand; other dimensions use an exact scan.
CREATE INDEX "conversation_attachment_chunks_hnsw_1536" ON "conversation_attachment_chunks" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops) WHERE vector_dims("embedding") = 1536;
