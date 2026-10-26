-- AlterTable
ALTER TABLE "conversation_attachments" ADD COLUMN     "uploaderAgentRef" TEXT,
ALTER COLUMN "uploaderUserId" DROP NOT NULL;
