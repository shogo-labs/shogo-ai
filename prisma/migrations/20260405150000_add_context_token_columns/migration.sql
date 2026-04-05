-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "contextUsageTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "chat_sessions" ADD COLUMN "contextWindowTokens" INTEGER NOT NULL DEFAULT 0;
