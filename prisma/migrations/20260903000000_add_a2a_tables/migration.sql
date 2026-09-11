-- CreateTable
CREATE TABLE "a2a_api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "a2a_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_tasks" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "taskJson" TEXT NOT NULL,
    "chatSessionId" TEXT,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "a2a_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "a2a_api_keys_keyId_key" ON "a2a_api_keys"("keyId");

-- CreateIndex
CREATE INDEX "a2a_api_keys_projectId_idx" ON "a2a_api_keys"("projectId");

-- CreateIndex
CREATE INDEX "a2a_tasks_projectId_contextId_idx" ON "a2a_tasks"("projectId", "contextId");

-- CreateIndex
CREATE INDEX "a2a_tasks_projectId_updatedAt_idx" ON "a2a_tasks"("projectId", "updatedAt");

-- AddForeignKey
ALTER TABLE "a2a_api_keys" ADD CONSTRAINT "a2a_api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
