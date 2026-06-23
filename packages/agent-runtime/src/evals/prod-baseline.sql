-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Shogo Technologies, Inc.
--
-- prod-baseline.sql — per-signature daily time series for the Hoshi
-- reliability fixes (WS1–WS9).
--
-- HOW TO USE
--   psql "$DATABASE_URL" -f packages/agent-runtime/src/evals/prod-baseline.sql
--   …or copy a single block into a SQL console.
--
-- This is the "proof loop": capture a baseline BEFORE shipping a workstream,
-- then re-run the same block a few days AFTER deploy and diff the daily series.
-- (Same method that proved hardening A1: `read_file` arg errors went 22% → 0%.)
--
-- Each block is tagged with the workstream and the eval tag that reproduces it
-- (see the `prod:*` tags in test-cases-*.ts), so an eval ID maps 1:1 to a
-- production metric.
--
-- Schema (Postgres, prisma/schema.prisma):
--   tool_call_logs(toolName, status['streaming'|'executing'|'complete'|'error'],
--                  args jsonb, result jsonb, duration, "createdAt", "chatSessionId", "messageId")
--   chat_messages(role['user'|'assistant'], content, model, "createdAt", "sessionId")
--   agent_cost_metrics("hitMaxTurns","loopDetected",escalated,"responseEmpty",success,model,"createdAt")
--   analytics_digests(date, period, region, "aiInsights" jsonb, "chunksProcessed")
--
-- Notes:
--   * `result`/`args` are jsonb — substring-match via `result::text ILIKE …`.
--   * The default window is the last 21 days; tweak WINDOW_DAYS per block.
--   * `day` is UTC-truncated `createdAt`.

-- ===========================================================================
-- Convenience: a reusable window. Most blocks inline `now() - interval '21 days'`
-- so they can be copy-pasted individually; change the interval as needed.
-- ===========================================================================


-- ===========================================================================
-- WS5 — edit_file "read-before-edit"   [eval tag: prod:file-has-not-been-read]
-- Signature: `File has not been read yet`
-- Metric: daily count + share of edit_file calls that hit the guard.
-- Expect: → ~0 after the auto-read fallback + key normalization ship.
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                              AS day,
  count(*) FILTER (WHERE "toolName" = 'edit_file')                            AS edit_file_calls,
  count(*) FILTER (
    WHERE "toolName" = 'edit_file'
      AND result::text ILIKE '%has not been read%'
  )                                                                           AS read_before_edit_errors,
  round(
    100.0 * count(*) FILTER (
      WHERE "toolName" = 'edit_file' AND result::text ILIKE '%has not been read%'
    ) / nullif(count(*) FILTER (WHERE "toolName" = 'edit_file'), 0)
  , 2)                                                                        AS pct_of_edits
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS6 — search tool advertised but unregistered   [eval tag: prod:tool-search-not-found]
-- Signature: `Tool search not found` (prompts advertise `search`, prod never
-- registers it because SHOGO_SEARCH_ENABLED is unset).
-- Metric: daily count of search-tool not-found failures.
-- Expect: → 0 after gating the advertisement behind the flag.
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS tool_search_not_found
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
  AND status = 'error'
  AND (
    "toolName" = 'search'
    OR result::text ILIKE '%tool search not found%'
    OR result::text ILIKE '%search%not found%'
  )
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS7 — core tools reported missing in agent mode   [eval tag: (core-tool contract)]
-- Signature: `Tool exec not found` / `Tool edit_file not found` / `Tool write_file not found`
-- Metric: daily count per core tool name.
-- Expect: → 0 after the agent-mode core-tool guarantee + mode-aware stubs.
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*) FILTER (WHERE result::text ILIKE '%tool exec not found%')         AS exec_not_found,
  count(*) FILTER (WHERE result::text ILIKE '%tool edit_file not found%')    AS edit_file_not_found,
  count(*) FILTER (WHERE result::text ILIKE '%tool write_file not found%')   AS write_file_not_found,
  count(*) FILTER (WHERE result::text ~* 'tool [a-z_]+ not found')           AS any_tool_not_found
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
  AND status = 'error'
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS1 — premature stopping / "continue"   [eval tag: prod:premature-stop-continue]
-- Signature A: users typing "continue" to resume an interrupted task.
-- Signature B: assistant turns that end by asking permission ("…continue?").
-- Metric: daily counts of both.
-- Expect: ↓ after autonomy prompt + ask_user tightening + softer limit string.
-- ===========================================================================
-- A) user "continue" nudges
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS user_continue_msgs
FROM chat_messages
WHERE "createdAt" >= now() - interval '21 days'
  AND role = 'user'
  AND btrim(lower(content)) IN ('continue', 'continue.', 'keep going', 'go on', 'yes continue')
GROUP BY 1
ORDER BY 1;

-- B) assistant turns ending with a permission-to-continue question
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*) FILTER (WHERE right(btrim(content), 1) = '?')                     AS assistant_turns_ending_question,
  count(*)                                                                   AS assistant_turns,
  round(
    100.0 * count(*) FILTER (WHERE right(btrim(content), 1) = '?')
      / nullif(count(*), 0)
  , 2)                                                                       AS pct_ending_question
FROM chat_messages
WHERE "createdAt" >= now() - interval '21 days'
  AND role = 'assistant'
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS2 — preview / deploy reachability
--   [eval tags: prod:preview-cant-be-reached, prod:save-host-local-export]
-- Signature A: agent asserts "works on my end" (unverifiable success claim).
-- Signature B: user reports the preview "can't be reached" / "won't load".
-- Signature C: user wants to "save / host / share permanently" (→ Publish).
-- Metric: daily message counts.
-- Expect: A & B ↓ after the /sandbox/url cold-pod readiness + auto-wake fix;
--         C steered to Publish.
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*) FILTER (
    WHERE role = 'assistant' AND content ILIKE '%works on my end%'
  )                                                                          AS works_on_my_end,
  count(*) FILTER (
    WHERE role = 'user' AND (
      content ILIKE '%can%t be reached%'
      OR content ILIKE '%cannot be reached%'
      OR content ILIKE '%won%t load%'
      OR content ILIKE '%site can%t be reached%'
      OR content ILIKE '%page isn%t working%'
    )
  )                                                                          AS cant_be_reached,
  count(*) FILTER (
    WHERE role = 'user' AND (
      content ILIKE '%save%to my computer%'
      OR content ILIKE '%host this%'
      OR content ILIKE '%host it%'
      OR content ILIKE '%share%permanently%'
      OR content ILIKE '%download%project%'
    )
  )                                                                          AS save_host_requests
FROM chat_messages
WHERE "createdAt" >= now() - interval '21 days'
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS3 — non-converging / repeat bugs
--   [eval tags: prod:repeat-nonconverging-bugs, prod:canvas-runtime-crash]
-- Signature A: user resends "again" / "still" / "same error" (agent fixing one
--   instance at a time).
-- Signature B: canvas/runtime crashes surfaced as tool errors.
-- Metric: daily message + error counts.
-- Expect: ↓ after "fix the class" prompt + runtime-error feedback into the loop.
-- ===========================================================================
-- A) "again / still / same" resends
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS repeat_complaints
FROM chat_messages
WHERE "createdAt" >= now() - interval '21 days'
  AND role = 'user'
  AND (
    content ILIKE '%still%not%'
    OR content ILIKE '%same error%'
    OR content ILIKE '%again%'
    OR content ILIKE '%still broken%'
    OR content ILIKE '%didn%t work%'
  )
GROUP BY 1
ORDER BY 1;

-- B) runtime-crash-class tool errors (e.g. "X is not a function", "undefined is not")
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS runtime_crash_errors
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
  AND status = 'error'
  AND (
    result::text ILIKE '%is not a function%'
    OR result::text ILIKE '%is not defined%'
    OR result::text ILIKE '%cannot read propert%'
    OR result::text ILIKE '%undefined is not%'
  )
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS4 — work loss + checkpoints
--   [eval tags: prod:no-git-history-claim, prod:work-loss-restore, prod:resume-started-over]
-- Signature A: agent claims "no git history" / "nothing to revert to".
-- Signature B: user asks to restore / go back / undo / "I lost my work".
-- Metric: daily message counts.
-- Expect: A → 0 once the agent has the checkpoint tool; B handled via rollback.
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*) FILTER (
    WHERE role = 'assistant' AND (
      content ILIKE '%no git history%'
      OR content ILIKE '%no commit history%'
      OR content ILIKE '%nothing to revert%'
      OR content ILIKE '%no previous version%'
    )
  )                                                                          AS no_history_claims,
  count(*) FILTER (
    WHERE role = 'user' AND (
      content ILIKE '%go back to%'
      OR content ILIKE '%revert%'
      OR content ILIKE '%restore%'
      OR content ILIKE '%undo%'
      OR content ILIKE '%lost my work%'
      OR content ILIKE '%lost some work%'
      OR content ILIKE '%why did you start over%'
    )
  )                                                                          AS restore_requests
FROM chat_messages
WHERE "createdAt" >= now() - interval '21 days'
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- WS8 — analytics digest 404 (insights broken daily)   [eval: model-resolution unit]
-- Signature: the daily digest POSTed a non-Anthropic model id to
-- api.anthropic.com → 404 → aiInsights null despite conversations existing.
-- Metric: daily digests with conversations but no insights.
-- Expect: → 0 after routing the digest through the shared multi-provider
-- resolver (resolveLanguageModel), so the basic default works for any provider.
-- (Requires the analytics_digests table; skip if absent.)
-- ===========================================================================
SELECT
  date                                                                        AS digest_date,
  period,
  region,
  "chunksProcessed",
  ("aiInsights" IS NULL)                                                      AS insights_missing
FROM analytics_digests
WHERE date >= (now() - interval '21 days')::date
ORDER BY date DESC, period, region;


-- ===========================================================================
-- WS9 — integration (Composio) error surfacing   [eval tag: prod:integration-error-surfacing]
-- Signature: integration tool calls (UPPERCASE_WITH_UNDERSCORE slugs) fail.
-- Metric: daily error rate per integration prefix + the worst offenders.
-- Expect: actionable hints + dead-slug gating reduce error rate / retry loops.
-- ===========================================================================
-- A) error rate for Composio-style tools (slug = ALLCAPS with an underscore)
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS integration_calls,
  count(*) FILTER (WHERE status = 'error')                                   AS integration_errors,
  round(
    100.0 * count(*) FILTER (WHERE status = 'error') / nullif(count(*), 0)
  , 2)                                                                       AS pct_error
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
  AND "toolName" ~ '^[A-Z][A-Z0-9]+_[A-Z0-9_]+$'
GROUP BY 1
ORDER BY 1;

-- B) worst-offender integration tools by error count (last 21 days)
SELECT
  "toolName",
  count(*)                                                                   AS calls,
  count(*) FILTER (WHERE status = 'error')                                   AS errors,
  round(
    100.0 * count(*) FILTER (WHERE status = 'error') / nullif(count(*), 0)
  , 2)                                                                       AS pct_error
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
  AND "toolName" ~ '^[A-Z][A-Z0-9]+_[A-Z0-9_]+$'
GROUP BY "toolName"
HAVING count(*) >= 5
ORDER BY errors DESC, pct_error DESC
LIMIT 40;


-- ===========================================================================
-- Cross-cutting — run-health signals (agent_cost_metrics)
-- Not a single signature, but the same fixes should move these: fewer
-- max-turns ceilings, fewer loop trips, fewer empty responses.
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS runs,
  count(*) FILTER (WHERE "hitMaxTurns")                                      AS hit_max_turns,
  count(*) FILTER (WHERE "loopDetected")                                     AS loop_detected,
  count(*) FILTER (WHERE escalated)                                          AS escalated,
  count(*) FILTER (WHERE "responseEmpty")                                    AS response_empty,
  round(100.0 * count(*) FILTER (WHERE "hitMaxTurns") / nullif(count(*), 0), 2) AS pct_max_turns,
  round(100.0 * count(*) FILTER (WHERE "loopDetected") / nullif(count(*), 0), 2) AS pct_loop
FROM agent_cost_metrics
WHERE "createdAt" >= now() - interval '21 days'
GROUP BY 1
ORDER BY 1;


-- ===========================================================================
-- Overall tool error rate (sanity backdrop for all of the above)
-- ===========================================================================
SELECT
  date_trunc('day', "createdAt")                                             AS day,
  count(*)                                                                   AS tool_calls,
  count(*) FILTER (WHERE status = 'error')                                   AS errors,
  round(100.0 * count(*) FILTER (WHERE status = 'error') / nullif(count(*), 0), 2) AS pct_error
FROM tool_call_logs
WHERE "createdAt" >= now() - interval '21 days'
GROUP BY 1
ORDER BY 1;
