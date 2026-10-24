-- Migration: backfill_agent_cost_metrics_cache_costs
--
-- Data-only. Repairs Cost Analytics history recorded before
-- `agent_cost_metrics.cacheWriteTokens` existed, from the usage events that
-- already carry the full token breakdown and the correctly priced cost:
--
--   1. `main-chat` rows recorded from a turn's stream-reported usage (cloud
--      forwarding): copy cache writes and cost from the `chat_message` usage
--      event written alongside them, matched on chat session, time and
--      identical token counts.
--   2. Sub-agent rows: copy cache writes and cost from the per-call
--      `ai_proxy_completion` events inside the run's time window, only when
--      those events' token sums match the row exactly.
--   3. API-key / local-model installs never wrote `main-chat` rows, only
--      per-call events. Rebuild one row per turn (calls on the same
--      workspace/project/member less than 5 minutes apart), skipping calls
--      inside a sub-agent run window. These rows have no quality signals, so
--      they are tagged `qualityUnknown` and kept out of quality metrics.
--
-- Every JSON read is guarded by json_valid(): json_extract() raises on
-- malformed text, which would fail this migration and block later launches.

-- 1. main-chat rows recorded from stream usage
WITH ev AS (
  SELECT
    "workspaceId",
    "projectId",
    julianday("createdAt") AS jd,
    CASE WHEN json_valid("actionMetadata") THEN json_extract("actionMetadata", '$.chatSessionId') END AS chatSessionId,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.inputTokens'), 0) END AS inputTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.outputTokens'), 0) END AS outputTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.cachedInputTokens'), 0) END AS cachedInputTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.cacheWriteTokens'), 0) END AS cacheWriteTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.tokenRawUsd'), "rawUsd") ELSE "rawUsd" END AS rawUsd
  FROM "usage_events"
  WHERE "actionType" = 'chat_message'
),
acm AS (
  SELECT
    "id",
    "workspaceId",
    "projectId",
    julianday("createdAt") AS jd,
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.chatSessionId') END AS chatSessionId
  FROM "agent_cost_metrics"
  WHERE "agentType" = 'main-chat' AND "cacheWriteTokens" = 0
),
cand AS (
  SELECT
    acm."id" AS mid,
    ev.cacheWriteTokens AS cw,
    ev.rawUsd AS raw,
    row_number() OVER (PARTITION BY acm."id" ORDER BY abs(ev.jd - acm.jd)) AS rn
  FROM acm
  JOIN ev
    ON ev."workspaceId" = acm."workspaceId"
   AND ev."projectId" IS acm."projectId"
   AND ev.chatSessionId IS acm.chatSessionId
   AND abs(ev.jd - acm.jd) < 5.0 / 86400
   AND ev.inputTokens = acm."inputTokens"
   AND ev.outputTokens = acm."outputTokens"
   AND ev.cachedInputTokens = acm."cachedInputTokens"
   AND ev.rawUsd IS NOT NULL
),
matched AS (SELECT mid, cw, raw FROM cand WHERE rn = 1)
UPDATE "agent_cost_metrics"
SET
  "cacheWriteTokens" = (SELECT cw FROM matched WHERE mid = "agent_cost_metrics"."id"),
  "creditCost" = (SELECT raw FROM matched WHERE mid = "agent_cost_metrics"."id")
WHERE "id" IN (SELECT mid FROM matched);

-- 2. Sub-agent rows, exact attribution only
WITH calls AS (
  SELECT
    "workspaceId",
    "projectId",
    julianday("createdAt") AS jd,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.inputTokens'), 0) ELSE 0 END AS inputTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.outputTokens'), 0) ELSE 0 END AS outputTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.cachedInputTokens'), 0) ELSE 0 END AS cachedInputTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE(json_extract("actionMetadata", '$.cacheWriteTokens'), 0) ELSE 0 END AS cacheWriteTokens,
    CASE WHEN json_valid("actionMetadata") THEN COALESCE("rawUsd", json_extract("actionMetadata", '$.rawUsd'), 0) ELSE COALESCE("rawUsd", 0) END AS rawUsd
  FROM "usage_events"
  WHERE "actionType" = 'ai_proxy_completion'
),
runs AS (
  SELECT
    "id",
    "workspaceId",
    "projectId",
    julianday("createdAt") - ("wallTimeMs" + 5000) / 86400000.0 AS startJd,
    julianday("createdAt") + 5.0 / 86400 AS endJd,
    "inputTokens",
    "outputTokens",
    "cachedInputTokens"
  FROM "agent_cost_metrics"
  WHERE "agentType" NOT IN ('main-chat', 'main-chat-failed')
    AND "cacheWriteTokens" = 0
    AND ("inputTokens" > 0 OR "outputTokens" > 0 OR "cachedInputTokens" > 0)
),
sums AS (
  SELECT
    runs."id" AS rid,
    SUM(calls.inputTokens) AS i,
    SUM(calls.outputTokens) AS o,
    SUM(calls.cachedInputTokens) AS cr,
    SUM(calls.cacheWriteTokens) AS cw,
    SUM(calls.rawUsd) AS raw
  FROM runs
  JOIN calls
    ON calls."workspaceId" = runs."workspaceId"
   AND calls."projectId" IS runs."projectId"
   AND calls.jd BETWEEN runs.startJd AND runs.endJd
  GROUP BY runs."id"
),
exact AS (
  SELECT sums.rid, sums.cw, sums.raw
  FROM sums
  JOIN runs ON runs."id" = sums.rid
  WHERE sums.i = runs."inputTokens"
    AND sums.o = runs."outputTokens"
    AND sums.cr = runs."cachedInputTokens"
)
UPDATE "agent_cost_metrics"
SET
  "cacheWriteTokens" = (SELECT cw FROM exact WHERE rid = "agent_cost_metrics"."id"),
  "creditCost" = (SELECT raw FROM exact WHERE rid = "agent_cost_metrics"."id")
WHERE "id" IN (SELECT rid FROM exact);

-- 3. Rebuild main-chat turns from per-call events
WITH subagent_runs AS (
  SELECT
    "workspaceId",
    "projectId",
    julianday("createdAt") - ("wallTimeMs" + 5000) / 86400000.0 AS startJd,
    julianday("createdAt") + 5.0 / 86400 AS endJd
  FROM "agent_cost_metrics"
  WHERE "agentType" NOT IN ('main-chat', 'main-chat-failed')
),
calls AS (
  SELECT
    e."id",
    e."workspaceId",
    e."projectId",
    e."memberId",
    e."createdAt",
    julianday(e."createdAt") AS jd,
    CASE WHEN json_valid(e."actionMetadata") THEN json_extract(e."actionMetadata", '$.model') END AS model,
    CASE WHEN json_valid(e."actionMetadata") THEN COALESCE(json_extract(e."actionMetadata", '$.inputTokens'), 0) ELSE 0 END AS inputTokens,
    CASE WHEN json_valid(e."actionMetadata") THEN COALESCE(json_extract(e."actionMetadata", '$.outputTokens'), 0) ELSE 0 END AS outputTokens,
    CASE WHEN json_valid(e."actionMetadata") THEN COALESCE(json_extract(e."actionMetadata", '$.cachedInputTokens'), 0) ELSE 0 END AS cachedInputTokens,
    CASE WHEN json_valid(e."actionMetadata") THEN COALESCE(json_extract(e."actionMetadata", '$.cacheWriteTokens'), 0) ELSE 0 END AS cacheWriteTokens,
    CASE WHEN json_valid(e."actionMetadata") THEN COALESCE(e."rawUsd", json_extract(e."actionMetadata", '$.rawUsd'), 0) ELSE COALESCE(e."rawUsd", 0) END AS rawUsd
  FROM "usage_events" e
  WHERE e."actionType" = 'ai_proxy_completion'
    AND NOT EXISTS (
      SELECT 1 FROM subagent_runs s
      WHERE s."workspaceId" = e."workspaceId"
        AND s."projectId" IS e."projectId"
        AND julianday(e."createdAt") BETWEEN s.startJd AND s.endJd
    )
),
marked AS (
  SELECT
    calls.*,
    CASE
      WHEN jd - lag(jd) OVER (PARTITION BY "workspaceId", "projectId", "memberId" ORDER BY jd) < 5.0 / 1440 THEN 0
      ELSE 1
    END AS isStart
  FROM calls
),
numbered AS (
  SELECT
    marked.*,
    SUM(isStart) OVER (
      PARTITION BY "workspaceId", "projectId", "memberId"
      ORDER BY jd
      ROWS UNBOUNDED PRECEDING
    ) AS turnNo
  FROM marked
),
labeled AS (
  SELECT
    numbered.*,
    first_value("id") OVER turn_w AS firstId,
    first_value(model) OVER (
      PARTITION BY "workspaceId", "projectId", "memberId", turnNo
      ORDER BY jd DESC
    ) AS lastModel
  FROM numbered
  WINDOW turn_w AS (PARTITION BY "workspaceId", "projectId", "memberId", turnNo ORDER BY jd)
)
INSERT OR IGNORE INTO "agent_cost_metrics" (
  "id", "workspaceId", "projectId", "agentType", "model",
  "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
  "toolCalls", "creditCost", "wallTimeMs",
  "success", "hitMaxTurns", "loopDetected", "escalated", "responseEmpty",
  "metadata", "createdAt"
)
SELECT
  'backfill-' || firstId,
  "workspaceId",
  "projectId",
  'main-chat',
  COALESCE(MAX(lastModel), 'sonnet'),
  SUM(inputTokens),
  SUM(outputTokens),
  SUM(cachedInputTokens),
  SUM(cacheWriteTokens),
  COUNT(*),
  SUM(rawUsd),
  CAST(ROUND((MAX(jd) - MIN(jd)) * 86400000) AS INTEGER),
  1, 0, 0, 0, 0,
  '{"usageSource":"local-proxy","backfill":"cache-cost-2026-10","qualityUnknown":true}',
  MAX("createdAt")
FROM labeled
GROUP BY "workspaceId", "projectId", "memberId", turnNo, firstId
HAVING SUM(inputTokens) + SUM(outputTokens) + SUM(cachedInputTokens) + SUM(cacheWriteTokens) > 0;
