-- Add project opt-in for workspace-level Slack routing.
ALTER TABLE "projects"
ADD COLUMN "slackEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "slack_workspace_installations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackTeamName" TEXT,
    "botAccessTokenEncrypted" TEXT NOT NULL,
    "botUserId" TEXT,
    "installerUserId" TEXT,
    "defaultProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_workspace_installations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_workspace_installations_workspaceId_key"
ON "slack_workspace_installations"("workspaceId");

CREATE UNIQUE INDEX "slack_workspace_installations_slackTeamId_key"
ON "slack_workspace_installations"("slackTeamId");

CREATE INDEX "slack_workspace_installations_defaultProjectId_idx"
ON "slack_workspace_installations"("defaultProjectId");

CREATE TABLE "slack_user_links" (
    "id" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "shogoUserId" TEXT NOT NULL,
    "personalDefaultProjectId" TEXT,
    "lastUsedProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_user_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_user_links_slackTeamId_slackUserId_key"
ON "slack_user_links"("slackTeamId", "slackUserId");

CREATE INDEX "slack_user_links_shogoUserId_idx"
ON "slack_user_links"("shogoUserId");

CREATE INDEX "slack_user_links_personalDefaultProjectId_idx"
ON "slack_user_links"("personalDefaultProjectId");

CREATE INDEX "slack_user_links_lastUsedProjectId_idx"
ON "slack_user_links"("lastUsedProjectId");

CREATE TABLE "slack_channel_settings" (
    "id" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "defaultProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_channel_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_channel_settings_slackTeamId_slackChannelId_key"
ON "slack_channel_settings"("slackTeamId", "slackChannelId");

CREATE INDEX "slack_channel_settings_defaultProjectId_idx"
ON "slack_channel_settings"("defaultProjectId");

CREATE TABLE "slack_project_routing_rules" (
    "id" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_project_routing_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_project_routing_rules_slackTeamId_keyword_key"
ON "slack_project_routing_rules"("slackTeamId", "keyword");

CREATE INDEX "slack_project_routing_rules_projectId_idx"
ON "slack_project_routing_rules"("projectId");

ALTER TABLE "slack_workspace_installations"
ADD CONSTRAINT "slack_workspace_installations_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "slack_workspace_installations"
ADD CONSTRAINT "slack_workspace_installations_defaultProjectId_fkey"
FOREIGN KEY ("defaultProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "slack_user_links"
ADD CONSTRAINT "slack_user_links_slackTeamId_fkey"
FOREIGN KEY ("slackTeamId") REFERENCES "slack_workspace_installations"("slackTeamId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "slack_user_links"
ADD CONSTRAINT "slack_user_links_shogoUserId_fkey"
FOREIGN KEY ("shogoUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "slack_user_links"
ADD CONSTRAINT "slack_user_links_personalDefaultProjectId_fkey"
FOREIGN KEY ("personalDefaultProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "slack_user_links"
ADD CONSTRAINT "slack_user_links_lastUsedProjectId_fkey"
FOREIGN KEY ("lastUsedProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "slack_channel_settings"
ADD CONSTRAINT "slack_channel_settings_slackTeamId_fkey"
FOREIGN KEY ("slackTeamId") REFERENCES "slack_workspace_installations"("slackTeamId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "slack_channel_settings"
ADD CONSTRAINT "slack_channel_settings_defaultProjectId_fkey"
FOREIGN KEY ("defaultProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "slack_project_routing_rules"
ADD CONSTRAINT "slack_project_routing_rules_slackTeamId_fkey"
FOREIGN KEY ("slackTeamId") REFERENCES "slack_workspace_installations"("slackTeamId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "slack_project_routing_rules"
ADD CONSTRAINT "slack_project_routing_rules_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
