-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('APP', 'AGENT');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "thumbnailUrl" TEXT,
ADD COLUMN     "type" "ProjectType" NOT NULL DEFAULT 'APP';

-- CreateTable
CREATE TABLE "agent_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "heartbeatInterval" INTEGER NOT NULL DEFAULT 1800,
    "heartbeatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "modelProvider" TEXT NOT NULL DEFAULT 'anthropic',
    "modelName" TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "projectId" TEXT,
    "workspaceId" TEXT,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "createdBy" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_configs_projectId_key" ON "agent_configs"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_key" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_token_idx" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_projectId_idx" ON "invite_links"("projectId");

-- AddForeignKey
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
