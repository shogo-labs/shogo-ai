-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('online', 'offline');

-- CreateTable
CREATE TABLE "instances" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT,
    "arch" TEXT,
    "status" "InstanceStatus" NOT NULL DEFAULT 'offline',
    "lastSeenAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instances_workspaceId_idx" ON "instances"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "instances_workspaceId_hostname_key" ON "instances"("workspaceId", "hostname");

-- AddForeignKey
ALTER TABLE "instances" ADD CONSTRAINT "instances_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
