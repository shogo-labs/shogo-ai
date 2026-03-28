-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "ssoSettings" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workspaceId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'starter',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "schemas" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "folderId" TEXT,
    "publishedSubdomain" TEXT,
    "publishedAt" DATETIME,
    "accessLevel" TEXT NOT NULL DEFAULT 'anyone',
    "category" TEXT,
    "type" TEXT NOT NULL DEFAULT 'APP',
    "siteTitle" TEXT,
    "siteDescription" TEXT,
    "thumbnailUrl" TEXT,
    "templateId" TEXT,
    "knativeServiceName" TEXT,
    "settings" TEXT,
    CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "projects_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "heartbeatInterval" INTEGER NOT NULL DEFAULT 1800,
    "heartbeatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "nextHeartbeatAt" DATETIME,
    "channels" TEXT NOT NULL DEFAULT '[]',
    "modelProvider" TEXT NOT NULL DEFAULT 'anthropic',
    "modelName" TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "agent_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "project_checkpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "includesDb" BOOLEAN NOT NULL DEFAULT false,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_checkpoints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "github_connections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "installationId" INTEGER,
    "repoId" INTEGER,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPushAt" DATETIME,
    "lastPullAt" DATETIME,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "github_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "starred_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "starred_projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "starred_projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "starred_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "workspaceId" TEXT,
    "projectId" TEXT,
    "isBillingAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "taxId" TEXT,
    "creditsBalance" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "billing_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "workspaceId" TEXT,
    "projectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "emailStatus" TEXT NOT NULL DEFAULT 'not_sent',
    "emailSentAt" DATETIME,
    "emailError" TEXT,
    "invitedBy" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "invitations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "projectId" TEXT,
    "workspaceId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdBy" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "invite_links_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invite_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "folders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "folders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "actionUrl" TEXT,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billingInterval" TEXT NOT NULL,
    "currentPeriodStart" DATETIME NOT NULL,
    "currentPeriodEnd" DATETIME NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "subscriptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "credit_ledgers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "monthlyCredits" REAL NOT NULL DEFAULT 0,
    "dailyCredits" REAL NOT NULL DEFAULT 0,
    "dailyCreditsDispensedThisMonth" REAL NOT NULL DEFAULT 0,
    "anniversaryDay" INTEGER NOT NULL,
    "lastDailyReset" DATETIME NOT NULL,
    "lastMonthlyReset" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "credit_ledgers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "memberId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionMetadata" TEXT,
    "creditCost" REAL NOT NULL,
    "creditSource" TEXT NOT NULL,
    "balanceBefore" REAL NOT NULL,
    "balanceAfter" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "usage_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "inferredName" TEXT NOT NULL,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT,
    "phase" TEXT,
    "claudeCodeSessionId" TEXT,
    "cachedMessageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_sessions_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "imageData" TEXT,
    "parts" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tool_call_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatSessionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "args" TEXT,
    "result" TEXT,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tool_call_logs_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "feature_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'discovery',
    "affectedPackages" TEXT NOT NULL DEFAULT '[]',
    "schemaName" TEXT,
    "initialAssessment" TEXT,
    "featureArchetype" TEXT,
    "applicablePatterns" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT,
    CONSTRAINT "feature_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "requirements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "auditVerdict" TEXT,
    "auditNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_decisions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "classification_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "initialAssessment" TEXT,
    "validatedArchetype" TEXT NOT NULL,
    "evidenceChecklist" TEXT,
    "rationale" TEXT NOT NULL,
    "correction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "classification_decisions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "analysis_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "relevantCode" TEXT,
    "recommendation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analysis_findings_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "integration_points" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "package" TEXT,
    "targetFunction" TEXT,
    "changeType" TEXT,
    "description" TEXT NOT NULL,
    "rationale" TEXT,
    "findingId" TEXT,
    "isGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "integration_points_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "integration_points_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "analysis_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "requirementId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "given" TEXT NOT NULL,
    "when" TEXT NOT NULL,
    "then" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'specified',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_cases_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "test_cases_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "implementation_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "integrationPointId" TEXT,
    "requirementId" TEXT,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'planned',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "implementation_tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "implementation_tasks_integrationPointId_fkey" FOREIGN KEY ("integrationPointId") REFERENCES "integration_points" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "implementation_tasks_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dependentTaskId" TEXT NOT NULL,
    "blockingTaskId" TEXT NOT NULL,
    CONSTRAINT "task_dependencies_dependentTaskId_fkey" FOREIGN KEY ("dependentTaskId") REFERENCES "implementation_tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_dependencies_blockingTaskId_fkey" FOREIGN KEY ("blockingTaskId") REFERENCES "implementation_tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_specifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "requirementId" TEXT,
    "scenario" TEXT NOT NULL,
    "given" TEXT NOT NULL DEFAULT '[]',
    "when" TEXT NOT NULL,
    "then" TEXT NOT NULL DEFAULT '[]',
    "testType" TEXT NOT NULL,
    "targetFile" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_specifications_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "implementation_tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "test_specifications_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "implementation_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "currentTaskId" TEXT,
    "completedTasks" TEXT NOT NULL DEFAULT '[]',
    "failedTasks" TEXT NOT NULL DEFAULT '[]',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "lastError" TEXT,
    CONSTRAINT "implementation_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "task_executions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "testFilePath" TEXT,
    "implementationFilePath" TEXT,
    "testOutput" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "task_executions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "implementation_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_executions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "implementation_tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "component_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "propsSchema" TEXT,
    "implementationRef" TEXT NOT NULL,
    "previewRef" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "supportedConfig" TEXT NOT NULL DEFAULT '[]',
    "aiGuidance" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "registries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "extendsId" TEXT,
    "fallbackComponentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "registries_extendsId_fkey" FOREIGN KEY ("extendsId") REFERENCES "registries" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "registries_fallbackComponentId_fkey" FOREIGN KEY ("fallbackComponentId") REFERENCES "component_definitions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "renderer_bindings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "registryId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "matchExpression" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "defaultConfig" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "renderer_bindings_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "registries" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "renderer_bindings_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "component_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "layout_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slots" TEXT NOT NULL DEFAULT '[]',
    "defaultBindings" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "compositions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "layoutId" TEXT NOT NULL,
    "slotContent" TEXT NOT NULL DEFAULT '[]',
    "dataContext" TEXT,
    "providerWrapper" TEXT,
    "providerConfig" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "compositions_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "layout_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "component_specs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "schemas" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requirements" TEXT,
    "layoutDecisions" TEXT,
    "dataBindings" TEXT,
    "interactionPatterns" TEXT,
    "reuseOpportunities" TEXT,
    "implementedAsId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "component_specs_implementedAsId_fkey" FOREIGN KEY ("implementedAsId") REFERENCES "component_definitions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "infra_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalNodes" INTEGER NOT NULL,
    "asgDesired" INTEGER NOT NULL,
    "asgMax" INTEGER NOT NULL,
    "totalPodSlots" INTEGER NOT NULL,
    "usedPodSlots" INTEGER NOT NULL,
    "totalCpuMillis" INTEGER NOT NULL,
    "usedCpuMillis" INTEGER NOT NULL,
    "limitCpuMillis" INTEGER NOT NULL DEFAULT 0,
    "warmAvailable" INTEGER NOT NULL,
    "warmTarget" INTEGER NOT NULL,
    "warmAssigned" INTEGER NOT NULL,
    "coldStarts" INTEGER NOT NULL DEFAULT 0,
    "totalProjects" INTEGER NOT NULL,
    "readyProjects" INTEGER NOT NULL,
    "runningProjects" INTEGER NOT NULL,
    "scaledToZero" INTEGER NOT NULL,
    "orphansDeleted" INTEGER NOT NULL DEFAULT 0,
    "idleEvictions" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "local_config" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "projects_publishedSubdomain_key" ON "projects"("publishedSubdomain");

-- CreateIndex
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");

-- CreateIndex
CREATE INDEX "projects_folderId_idx" ON "projects"("folderId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_configs_projectId_key" ON "agent_configs"("projectId");

-- CreateIndex
CREATE INDEX "project_checkpoints_projectId_createdAt_idx" ON "project_checkpoints"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "project_checkpoints_commitSha_idx" ON "project_checkpoints"("commitSha");

-- CreateIndex
CREATE UNIQUE INDEX "github_connections_projectId_key" ON "github_connections"("projectId");

-- CreateIndex
CREATE INDEX "github_connections_installationId_idx" ON "github_connections"("installationId");

-- CreateIndex
CREATE INDEX "github_connections_repoFullName_idx" ON "github_connections"("repoFullName");

-- CreateIndex
CREATE INDEX "starred_projects_workspaceId_idx" ON "starred_projects"("workspaceId");

-- CreateIndex
CREATE INDEX "starred_projects_projectId_idx" ON "starred_projects"("projectId");

-- CreateIndex
CREATE INDEX "starred_projects_userId_idx" ON "starred_projects"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "starred_projects_userId_projectId_key" ON "starred_projects"("userId", "projectId");

-- CreateIndex
CREATE INDEX "members_userId_idx" ON "members"("userId");

-- CreateIndex
CREATE INDEX "members_workspaceId_idx" ON "members"("workspaceId");

-- CreateIndex
CREATE INDEX "members_projectId_idx" ON "members"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_workspaceId_key" ON "billing_accounts"("workspaceId");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "invitations_workspaceId_idx" ON "invitations"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_key" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_token_idx" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_projectId_idx" ON "invite_links"("projectId");

-- CreateIndex
CREATE INDEX "folders_workspaceId_idx" ON "folders"("workspaceId");

-- CreateIndex
CREATE INDEX "folders_parentId_idx" ON "folders"("parentId");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripeSubscriptionId_key" ON "subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_workspaceId_idx" ON "subscriptions"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledgers_workspaceId_key" ON "credit_ledgers"("workspaceId");

-- CreateIndex
CREATE INDEX "usage_events_workspaceId_idx" ON "usage_events"("workspaceId");

-- CreateIndex
CREATE INDEX "usage_events_projectId_idx" ON "usage_events"("projectId");

-- CreateIndex
CREATE INDEX "usage_events_memberId_idx" ON "usage_events"("memberId");

-- CreateIndex
CREATE INDEX "usage_events_createdAt_idx" ON "usage_events"("createdAt");

-- CreateIndex
CREATE INDEX "chat_sessions_contextType_contextId_idx" ON "chat_sessions"("contextType", "contextId");

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_idx" ON "chat_messages"("sessionId");

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_createdAt_idx" ON "chat_messages"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "tool_call_logs_chatSessionId_idx" ON "tool_call_logs"("chatSessionId");

-- CreateIndex
CREATE INDEX "tool_call_logs_messageId_idx" ON "tool_call_logs"("messageId");

-- CreateIndex
CREATE INDEX "feature_sessions_projectId_idx" ON "feature_sessions"("projectId");

-- CreateIndex
CREATE INDEX "feature_sessions_status_idx" ON "feature_sessions"("status");

-- CreateIndex
CREATE INDEX "requirements_sessionId_idx" ON "requirements"("sessionId");

-- CreateIndex
CREATE INDEX "design_decisions_sessionId_idx" ON "design_decisions"("sessionId");

-- CreateIndex
CREATE INDEX "classification_decisions_sessionId_idx" ON "classification_decisions"("sessionId");

-- CreateIndex
CREATE INDEX "analysis_findings_sessionId_idx" ON "analysis_findings"("sessionId");

-- CreateIndex
CREATE INDEX "analysis_findings_type_idx" ON "analysis_findings"("type");

-- CreateIndex
CREATE INDEX "integration_points_sessionId_idx" ON "integration_points"("sessionId");

-- CreateIndex
CREATE INDEX "integration_points_findingId_idx" ON "integration_points"("findingId");

-- CreateIndex
CREATE INDEX "test_cases_sessionId_idx" ON "test_cases"("sessionId");

-- CreateIndex
CREATE INDEX "test_cases_requirementId_idx" ON "test_cases"("requirementId");

-- CreateIndex
CREATE INDEX "implementation_tasks_sessionId_idx" ON "implementation_tasks"("sessionId");

-- CreateIndex
CREATE INDEX "implementation_tasks_integrationPointId_idx" ON "implementation_tasks"("integrationPointId");

-- CreateIndex
CREATE INDEX "implementation_tasks_requirementId_idx" ON "implementation_tasks"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_dependentTaskId_blockingTaskId_key" ON "task_dependencies"("dependentTaskId", "blockingTaskId");

-- CreateIndex
CREATE INDEX "test_specifications_taskId_idx" ON "test_specifications"("taskId");

-- CreateIndex
CREATE INDEX "test_specifications_requirementId_idx" ON "test_specifications"("requirementId");

-- CreateIndex
CREATE INDEX "implementation_runs_sessionId_idx" ON "implementation_runs"("sessionId");

-- CreateIndex
CREATE INDEX "task_executions_runId_idx" ON "task_executions"("runId");

-- CreateIndex
CREATE INDEX "task_executions_taskId_idx" ON "task_executions"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "component_definitions_implementationRef_key" ON "component_definitions"("implementationRef");

-- CreateIndex
CREATE UNIQUE INDEX "registries_name_key" ON "registries"("name");

-- CreateIndex
CREATE INDEX "registries_extendsId_idx" ON "registries"("extendsId");

-- CreateIndex
CREATE INDEX "renderer_bindings_registryId_idx" ON "renderer_bindings"("registryId");

-- CreateIndex
CREATE INDEX "renderer_bindings_componentId_idx" ON "renderer_bindings"("componentId");

-- CreateIndex
CREATE INDEX "renderer_bindings_registryId_priority_idx" ON "renderer_bindings"("registryId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "layout_templates_name_key" ON "layout_templates"("name");

-- CreateIndex
CREATE INDEX "compositions_layoutId_idx" ON "compositions"("layoutId");

-- CreateIndex
CREATE INDEX "component_specs_implementedAsId_idx" ON "component_specs"("implementedAsId");

-- CreateIndex
CREATE INDEX "infra_snapshots_timestamp_idx" ON "infra_snapshots"("timestamp");

