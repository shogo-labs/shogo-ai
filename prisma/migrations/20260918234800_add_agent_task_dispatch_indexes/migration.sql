-- CreateIndex
CREATE INDEX "agent_tasks_status_dueAt_idx" ON "agent_tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "agent_tasks_status_updatedAt_idx" ON "agent_tasks"("status", "updatedAt");
