-- CreateTable
CREATE TABLE "workspace_root_secrets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "workspace_root_secrets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_root_secrets_runtimeKey_key" ON "workspace_root_secrets"("runtimeKey");

-- CreateIndex
CREATE INDEX "workspace_root_secrets_workspaceId_idx" ON "workspace_root_secrets"("workspaceId");
