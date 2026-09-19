CREATE TYPE "WorkspaceKind" AS ENUM ('personal', 'team');
CREATE TYPE "GoalStatus" AS ENUM ('active', 'paused', 'done');
CREATE TYPE "GoalEventKind" AS ENUM ('progress', 'blocker', 'approval', 'note', 'deliverable');

ALTER TABLE "workspaces"
  ADD COLUMN "kind" "WorkspaceKind" NOT NULL DEFAULT 'team';

ALTER TABLE "projects"
  ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "projects_workspaceId_hidden_idx" ON "projects"("workspaceId", "hidden");

ALTER TABLE "chat_sessions"
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "workspace_agent_profiles" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Shogo',
  "avatarUrl" TEXT,
  "tagline" TEXT,
  "personality" TEXT,
  "statusText" TEXT,
  "statusUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workspace_agent_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_agent_profiles_workspaceId_key"
  ON "workspace_agent_profiles"("workspaceId");

CREATE TABLE "goals" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "why" TEXT,
  "status" "GoalStatus" NOT NULL DEFAULT 'active',
  "plan" JSONB NOT NULL DEFAULT '[]',
  "deliverables" JSONB NOT NULL DEFAULT '[]',
  "nextCheckInAt" TIMESTAMP(3),
  "lastProgressAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goals_workspaceId_status_idx" ON "goals"("workspaceId", "status");
CREATE INDEX "goals_workspaceId_updatedAt_idx" ON "goals"("workspaceId", "updatedAt");

CREATE TABLE "goal_events" (
  "id" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "kind" "GoalEventKind" NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goal_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_events_goalId_createdAt_idx" ON "goal_events"("goalId", "createdAt");

ALTER TABLE "agent_tasks"
  ADD COLUMN "goalId" TEXT;

CREATE INDEX "agent_tasks_goalId_status_idx" ON "agent_tasks"("goalId", "status");

ALTER TABLE "workspace_agent_profiles"
  ADD CONSTRAINT "workspace_agent_profiles_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "goals"
  ADD CONSTRAINT "goals_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "goal_events"
  ADD CONSTRAINT "goal_events_goalId_fkey"
  FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_tasks"
  ADD CONSTRAINT "agent_tasks_goalId_fkey"
  FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "workspaces" AS w
SET "kind" = 'personal'
WHERE w."slug" LIKE 'user-%-personal'
  AND NOT EXISTS (
    SELECT 1
    FROM "projects" AS p
    WHERE p."workspaceId" = w."id"
  );
