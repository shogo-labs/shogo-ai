-- AlterTable
ALTER TABLE "custom_domains" ADD COLUMN     "certAuthority" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastRetriggerAt" TIMESTAMP(3),
ADD COLUMN     "retriggerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dnsOk" BOOLEAN,
ADD COLUMN     "diagnostics" TEXT;
