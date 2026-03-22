-- CreateEnum
CREATE TYPE "ProjectTier" AS ENUM ('starter', 'pro', 'enterprise', 'internal');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "AccessLevel" AS ENUM ('anyone', 'authenticated', 'private');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('not_sent', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('invitation_pending', 'invitation_accepted', 'member_joined', 'member_left', 'workspace_updated');

-- CreateEnum
CREATE TYPE "PlanId" AS ENUM ('pro', 'business', 'enterprise');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'past_due', 'canceled', 'trialing', 'paused');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('monthly', 'annual');

-- CreateEnum
CREATE TYPE "CreditSource" AS ENUM ('daily', 'monthly');

-- CreateEnum
CREATE TYPE "ContextType" AS ENUM ('feature', 'project', 'general');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('streaming', 'executing', 'complete', 'error');

-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('discovery', 'analysis', 'classification', 'design', 'spec', 'implementation', 'testing', 'complete');

-- CreateEnum
CREATE TYPE "FeatureArchetype" AS ENUM ('service', 'domain', 'infrastructure', 'hybrid');

-- CreateEnum
CREATE TYPE "RequirementPriority" AS ENUM ('must', 'should', 'could', 'wont');

-- CreateEnum
CREATE TYPE "RequirementStatus" AS ENUM ('proposed', 'accepted', 'implemented');

-- CreateEnum
CREATE TYPE "AuditVerdict" AS ENUM ('OK', 'REVISE', 'DROP', 'MERGE', 'DEFER');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('pattern', 'integration_point', 'risk', 'gap', 'existing_test', 'verification', 'classification_evidence');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('add', 'modify', 'extend', 'remove');

-- CreateEnum
CREATE TYPE "TestCaseStatus" AS ENUM ('specified', 'implemented', 'passing');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('planned', 'in_progress', 'complete', 'blocked');

-- CreateEnum
CREATE TYPE "TestType" AS ENUM ('unit', 'integration', 'acceptance');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('in_progress', 'blocked', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('pending', 'test_written', 'test_failing', 'implementing', 'test_passing', 'failed');

-- CreateEnum
CREATE TYPE "ComponentCategory" AS ENUM ('display', 'input', 'layout', 'visualization', 'section');

-- CreateEnum
CREATE TYPE "ComponentSpecType" AS ENUM ('section', 'renderer', 'composition');

-- CreateEnum
CREATE TYPE "ComponentSpecStatus" AS ENUM ('draft', 'approved', 'implemented');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "ssoSettings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workspaceId" TEXT NOT NULL,
    "tier" "ProjectTier" NOT NULL DEFAULT 'starter',
    "status" "ProjectStatus" NOT NULL DEFAULT 'draft',
    "schemas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folderId" TEXT,
    "publishedSubdomain" TEXT,
    "publishedAt" TIMESTAMP(3),
    "accessLevel" "AccessLevel" NOT NULL DEFAULT 'anyone',
    "siteTitle" TEXT,
    "siteDescription" TEXT,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "starred_projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starred_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "workspaceId" TEXT,
    "projectId" TEXT,
    "isBillingAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "taxId" TEXT,
    "creditsBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "workspaceId" TEXT,
    "projectId" TEXT,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "emailStatus" "EmailStatus" NOT NULL DEFAULT 'not_sent',
    "emailSentAt" TIMESTAMP(3),
    "emailError" TEXT,
    "invitedBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "actionUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "planId" "PlanId" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledgers" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dailyCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rolloverCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "anniversaryDay" INTEGER NOT NULL,
    "lastDailyReset" TIMESTAMP(3) NOT NULL,
    "lastMonthlyReset" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "memberId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionMetadata" JSONB,
    "creditCost" DOUBLE PRECISION NOT NULL,
    "creditSource" "CreditSource" NOT NULL,
    "balanceBefore" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "inferredName" TEXT NOT NULL,
    "contextType" "ContextType" NOT NULL,
    "contextId" TEXT,
    "phase" TEXT,
    "claudeCodeSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "imageData" TEXT,
    "parts" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_call_logs" (
    "id" TEXT NOT NULL,
    "chatSessionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" "ToolCallStatus" NOT NULL,
    "args" JSONB,
    "result" JSONB,
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_sessions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "status" "FeatureStatus" NOT NULL DEFAULT 'discovery',
    "affectedPackages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schemaName" TEXT,
    "initialAssessment" JSONB,
    "featureArchetype" "FeatureArchetype",
    "applicablePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT,

    CONSTRAINT "feature_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirements" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "RequirementPriority" NOT NULL,
    "status" "RequirementStatus" NOT NULL DEFAULT 'proposed',
    "auditVerdict" "AuditVerdict",
    "auditNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_decisions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification_decisions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "initialAssessment" "FeatureArchetype",
    "validatedArchetype" "FeatureArchetype" NOT NULL,
    "evidenceChecklist" JSONB,
    "rationale" TEXT NOT NULL,
    "correction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_findings" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FindingType" NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "relevantCode" TEXT,
    "recommendation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_points" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "package" TEXT,
    "targetFunction" TEXT,
    "changeType" "ChangeType",
    "description" TEXT NOT NULL,
    "rationale" TEXT,
    "findingId" TEXT,
    "isGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requirementId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "given" TEXT NOT NULL,
    "when" TEXT NOT NULL,
    "then" TEXT NOT NULL,
    "status" "TestCaseStatus" NOT NULL DEFAULT 'specified',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "implementation_tasks" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "integrationPointId" TEXT,
    "requirementId" TEXT,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "TaskStatus" NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "implementation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" TEXT NOT NULL,
    "dependentTaskId" TEXT NOT NULL,
    "blockingTaskId" TEXT NOT NULL,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_specifications" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "requirementId" TEXT,
    "scenario" TEXT NOT NULL,
    "given" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "when" TEXT NOT NULL,
    "then" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "testType" "TestType" NOT NULL,
    "targetFile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "implementation_runs" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'in_progress',
    "currentTaskId" TEXT,
    "completedTasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failedTasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "implementation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_executions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'pending',
    "testFilePath" TEXT,
    "implementationFilePath" TEXT,
    "testOutput" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "task_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ComponentCategory" NOT NULL,
    "description" TEXT,
    "propsSchema" JSONB,
    "implementationRef" TEXT NOT NULL,
    "previewRef" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supportedConfig" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiGuidance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "component_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registries" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "extendsId" TEXT,
    "fallbackComponentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renderer_bindings" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registryId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "matchExpression" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "defaultConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renderer_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layout_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slots" JSONB NOT NULL DEFAULT '[]',
    "defaultBindings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "layout_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compositions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "layoutId" TEXT NOT NULL,
    "slotContent" JSONB NOT NULL DEFAULT '[]',
    "dataContext" JSONB,
    "providerWrapper" TEXT,
    "providerConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_specs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "componentType" "ComponentSpecType" NOT NULL,
    "schemas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ComponentSpecStatus" NOT NULL DEFAULT 'draft',
    "requirements" JSONB,
    "layoutDecisions" JSONB,
    "dataBindings" JSONB,
    "interactionPatterns" JSONB,
    "reuseOpportunities" JSONB,
    "implementedAsId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "component_specs_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "starred_projects" ADD CONSTRAINT "starred_projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_sessions" ADD CONSTRAINT "feature_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_decisions" ADD CONSTRAINT "design_decisions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_decisions" ADD CONSTRAINT "classification_decisions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_points" ADD CONSTRAINT "integration_points_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_points" ADD CONSTRAINT "integration_points_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "analysis_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_tasks" ADD CONSTRAINT "implementation_tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_tasks" ADD CONSTRAINT "implementation_tasks_integrationPointId_fkey" FOREIGN KEY ("integrationPointId") REFERENCES "integration_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_tasks" ADD CONSTRAINT "implementation_tasks_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependentTaskId_fkey" FOREIGN KEY ("dependentTaskId") REFERENCES "implementation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blockingTaskId_fkey" FOREIGN KEY ("blockingTaskId") REFERENCES "implementation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_specifications" ADD CONSTRAINT "test_specifications_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "implementation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_specifications" ADD CONSTRAINT "test_specifications_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_runs" ADD CONSTRAINT "implementation_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "feature_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "implementation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "implementation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registries" ADD CONSTRAINT "registries_extendsId_fkey" FOREIGN KEY ("extendsId") REFERENCES "registries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registries" ADD CONSTRAINT "registries_fallbackComponentId_fkey" FOREIGN KEY ("fallbackComponentId") REFERENCES "component_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renderer_bindings" ADD CONSTRAINT "renderer_bindings_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renderer_bindings" ADD CONSTRAINT "renderer_bindings_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "component_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "layout_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_specs" ADD CONSTRAINT "component_specs_implementedAsId_fkey" FOREIGN KEY ("implementedAsId") REFERENCES "component_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
