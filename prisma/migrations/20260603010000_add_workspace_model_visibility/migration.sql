-- CreateTable
CREATE TABLE "workspace_model_visibility" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "workspace_model_visibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_model_visibility_workspaceId_idx" ON "workspace_model_visibility"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_model_visibility_workspaceId_modelId_key" ON "workspace_model_visibility"("workspaceId", "modelId");

-- AddForeignKey
ALTER TABLE "workspace_model_visibility" ADD CONSTRAINT "workspace_model_visibility_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
