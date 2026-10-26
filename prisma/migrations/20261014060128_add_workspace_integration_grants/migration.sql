-- AlterTable
ALTER TABLE "user_integration_grants" ADD COLUMN     "effect" TEXT NOT NULL DEFAULT 'allow';

-- CreateTable
CREATE TABLE "user_integration_workspace_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'own',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_integration_workspace_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_integration_workspace_grants_workspaceId_idx" ON "user_integration_workspace_grants"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "user_integration_workspace_grants_userId_workspaceId_provid_key" ON "user_integration_workspace_grants"("userId", "workspaceId", "provider");

-- AddForeignKey
ALTER TABLE "user_integration_workspace_grants" ADD CONSTRAINT "user_integration_workspace_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_integration_workspace_grants" ADD CONSTRAINT "user_integration_workspace_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

