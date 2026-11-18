-- CreateTable
CREATE TABLE "workspace_root_secrets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeKey" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_root_secrets_runtimeKey_key" ON "workspace_root_secrets"("runtimeKey");
