-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- AlterTable
ALTER TABLE "infra_snapshots" ADD COLUMN "limitCpuMillis" INTEGER NOT NULL DEFAULT 0;
