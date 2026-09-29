ALTER TABLE "workspaces"
ADD COLUMN "trainingDataMode" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE "proxy_turns" (
    "id" TEXT NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT,
    "chatSessionId" TEXT,
    "turnKey" TEXT NOT NULL,
    "resolvedModel" TEXT,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "userText" TEXT,
    "assistantText" TEXT,
    "toolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "archivePrefix" TEXT,
    "feedback" TEXT,
    "revertedAt" TIMESTAMP(3),
    "hadError" BOOLEAN NOT NULL DEFAULT false,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "userFollowupKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proxy_turns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "proxy_turns_workspaceId_turnKey_key"
ON "proxy_turns"("workspaceId", "turnKey");

CREATE INDEX "proxy_turns_workspaceId_lastAt_idx"
ON "proxy_turns"("workspaceId", "lastAt");

CREATE INDEX "proxy_turns_chatSessionId_lastAt_idx"
ON "proxy_turns"("chatSessionId", "lastAt");

CREATE INDEX "proxy_turns_source_idx"
ON "proxy_turns"("source");

ALTER TABLE "proxy_turns"
ADD CONSTRAINT "proxy_turns_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE VIEW "ai_analysis_turns" AS
SELECT
    'cloud_chat'::TEXT AS "source",
    s."workspaceId" AS "workspaceId",
    s."contextId" AS "projectId",
    m."sessionId" AS "chatSessionId",
    m."id" AS "turnId",
    p."createdBy" AS "userId",
    CASE WHEN m."role"::TEXT = 'user' THEN m."content" ELSE NULL END AS "userText",
    CASE WHEN m."role"::TEXT = 'assistant' THEN m."content" ELSE NULL END AS "assistantText",
    m."model" AS "model",
    1::INTEGER AS "llmCalls",
    m."createdAt" AS "createdAt"
FROM "chat_messages" m
JOIN "chat_sessions" s ON s."id" = m."sessionId"
LEFT JOIN "projects" p ON p."id" = s."contextId"
UNION ALL
SELECT
    p."source" AS "source",
    p."workspaceId" AS "workspaceId",
    p."projectId" AS "projectId",
    p."chatSessionId" AS "chatSessionId",
    p."id" AS "turnId",
    p."userId" AS "userId",
    p."userText" AS "userText",
    p."assistantText" AS "assistantText",
    p."resolvedModel" AS "model",
    p."llmCalls" AS "llmCalls",
    p."lastAt" AS "createdAt"
FROM "proxy_turns" p;
