-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'custom_domain_live';

-- AlterTable
ALTER TABLE "custom_domains" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "primary" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "custom_domains_groupId_idx" ON "custom_domains"("groupId");
