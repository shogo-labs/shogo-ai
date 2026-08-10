-- Composite index for the workspace-scoped project list.
--
-- `GET /api/projects?workspaceId=...&orderBy=createdAt:desc&limit=50` filters on
-- workspaceId and orders by createdAt. The existing single-column indexes cover
-- one half each, so Postgres read every row for the workspace and sorted it to
-- return a page. This index satisfies both halves in one scan.
--
-- Additive and small (the `projects` table is narrow), so the brief write lock
-- CREATE INDEX takes is a non-event -> zero downtime.
--
-- The redundant `projects_workspaceId_idx` is deliberately left in place: this
-- index covers it as a leftmost prefix, but dropping an index in production is a
-- separate decision from adding one.

-- CreateIndex
CREATE INDEX "projects_workspaceId_createdAt_idx" ON "projects"("workspaceId", "createdAt");
