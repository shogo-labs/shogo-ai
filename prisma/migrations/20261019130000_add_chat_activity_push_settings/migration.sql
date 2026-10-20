-- AlterTable
ALTER TABLE "chat_user_settings" ADD COLUMN     "dmInActivity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "threadRepliesInBadge" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mobilePushDelay" TEXT NOT NULL DEFAULT 'inactive';
