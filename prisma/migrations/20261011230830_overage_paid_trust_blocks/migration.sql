-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN     "overageOutstandingInvoiceId" TEXT,
ADD COLUMN     "overageOutstandingInvoiceUrl" TEXT,
ADD COLUMN     "overageOutstandingUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "overagePaidBlocks" INTEGER NOT NULL DEFAULT 0;

