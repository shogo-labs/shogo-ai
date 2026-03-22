-- Add foreign key constraints to StarredProject table
-- This fixes cascade delete issues when deleting workspaces

-- Add workspace foreign key
ALTER TABLE "starred_projects" ADD CONSTRAINT "starred_projects_workspaceId_fkey" 
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add project foreign key  
ALTER TABLE "starred_projects" ADD CONSTRAINT "starred_projects_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS "starred_projects_workspaceId_idx" ON "starred_projects"("workspaceId");
CREATE INDEX IF NOT EXISTS "starred_projects_projectId_idx" ON "starred_projects"("projectId");
