-- CreateEnum
CREATE TYPE "InstanceSize" AS ENUM ('micro', 'small', 'medium', 'large', 'xlarge');

-- AlterTable: Add instance size field to workspaces
ALTER TABLE "workspaces" ADD COLUMN "instanceSize" "InstanceSize" NOT NULL DEFAULT 'micro';

-- CreateTable: instance_subscriptions
CREATE TABLE "instance_subscriptions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "instanceSize" "InstanceSize" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: storage_usage
CREATE TABLE "storage_usage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "projectCount" INTEGER NOT NULL DEFAULT 0,
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_subscriptions_workspaceId_key" ON "instance_subscriptions"("workspaceId");
CREATE UNIQUE INDEX "instance_subscriptions_stripeSubscriptionId_key" ON "instance_subscriptions"("stripeSubscriptionId");
CREATE UNIQUE INDEX "storage_usage_workspaceId_key" ON "storage_usage"("workspaceId");

-- AddForeignKey
ALTER TABLE "instance_subscriptions" ADD CONSTRAINT "instance_subscriptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
