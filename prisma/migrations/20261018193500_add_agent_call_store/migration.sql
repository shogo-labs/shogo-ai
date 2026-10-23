-- Tracked `project_call` store: one record per call, one link per callee chat
-- session. Same models as prisma/schema.local.prisma; the store
-- (apps/api/src/lib/agent-call-store.ts) runs this one code path on both
-- surfaces.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script` against a database with the migration history
-- applied. The diff also reported unrelated pre-existing drift (a foreign-key
-- rename on usage_wallets and two index renames); those are deliberately left
-- out of this migration and tracked separately.
-- CreateTable
CREATE TABLE "agent_calls" (
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reply" TEXT,
    "error" TEXT,
    "sessionId" TEXT,
    "chatSessionId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_calls_pkey" PRIMARY KEY ("projectId","runId")
);

-- CreateTable
CREATE TABLE "agent_call_session_links" (
    "chatSessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_call_session_links_pkey" PRIMARY KEY ("chatSessionId")
);

-- CreateIndex
CREATE INDEX "agent_calls_status_updatedAt_idx" ON "agent_calls"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_calls_expiresAt_idx" ON "agent_calls"("expiresAt");

-- CreateIndex
CREATE INDEX "agent_call_session_links_expiresAt_idx" ON "agent_call_session_links"("expiresAt");

