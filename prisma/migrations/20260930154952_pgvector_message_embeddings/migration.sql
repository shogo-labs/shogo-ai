/*
  Warnings:

  - The `embedding` column on the `conversation_message_embeddings` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- AlterTable
ALTER TABLE "conversation_message_embeddings" DROP COLUMN "embedding",
ADD COLUMN     "embedding" vector;

-- Approximate nearest-neighbour index for 1536-dimension models (OpenAI
-- text-embedding-3-small, the default). Prisma can't express HNSW or
-- expression indexes, so this is added by hand; Prisma leaves it alone.
-- Other dimensions still work through an exact scan.
CREATE INDEX "conversation_message_embeddings_hnsw_1536" ON "conversation_message_embeddings" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops) WHERE vector_dims("embedding") = 1536;
