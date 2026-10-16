-- AlterTable
ALTER TABLE "chat_user_settings" ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "chat_reminders" ADD COLUMN     "target" TEXT;

-- AlterTable
ALTER TABLE "chat_inbox_items" ADD COLUMN     "target" TEXT;
