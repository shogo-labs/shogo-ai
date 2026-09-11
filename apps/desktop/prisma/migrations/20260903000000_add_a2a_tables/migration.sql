-- Migration: add_a2a_tables
-- Source:    prisma/schema.local.prisma
--
-- Hand-scoped, NOT the raw output of `bun run db:migrate:desktop`. That
-- script's `prisma migrate diff` run also picked up ~8 tables' worth of
-- pre-existing drift between this migration history and the current
-- schema (agent_configs, agent_eval_sets, budget_alerts, eval_runs,
-- model_experiments, subagent_model_overrides, usage_wallets,
-- workspace_grants, plus a signup_attributions index) that predates this
-- change and is already tracked as accepted tech debt in the allow-list
-- in scripts/check-desktop-schema-drift.ts. Bundling an unrelated
-- multi-table RedefineTables rewrite into this PR would be out of scope
-- and harder to review, so this migration is trimmed to exactly the two
-- new tables `A2aApiKey`/`A2aTask` add — verified to match the CREATE
-- TABLE/CREATE INDEX statements Prisma itself emitted for them before
-- trimming.

-- CreateTable
CREATE TABLE "a2a_api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "a2a_api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "a2a_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "taskJson" TEXT NOT NULL,
    "chatSessionId" TEXT,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "a2a_api_keys_keyId_key" ON "a2a_api_keys"("keyId");

-- CreateIndex
CREATE INDEX "a2a_api_keys_projectId_idx" ON "a2a_api_keys"("projectId");

-- CreateIndex
CREATE INDEX "a2a_tasks_projectId_contextId_idx" ON "a2a_tasks"("projectId", "contextId");

-- CreateIndex
CREATE INDEX "a2a_tasks_projectId_updatedAt_idx" ON "a2a_tasks"("projectId", "updatedAt");
