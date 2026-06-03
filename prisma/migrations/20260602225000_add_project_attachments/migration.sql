-- CreateTable
CREATE TABLE "project_attachments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "attachedProjectId" TEXT NOT NULL,
    "attachMode" TEXT NOT NULL DEFAULT 'readwrite',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_attachments_projectId_idx" ON "project_attachments"("projectId");

-- CreateIndex
CREATE INDEX "project_attachments_attachedProjectId_idx" ON "project_attachments"("attachedProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_attachments_projectId_attachedProjectId_key" ON "project_attachments"("projectId", "attachedProjectId");

-- AddForeignKey
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_attachedProjectId_fkey" FOREIGN KEY ("attachedProjectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
