-- AlterTable
ALTER TABLE "chat_user_settings" ADD COLUMN     "messageSound" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN     "huddleSound" TEXT NOT NULL DEFAULT 'ring';
