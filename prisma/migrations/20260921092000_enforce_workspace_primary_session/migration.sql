-- A workspace has exactly one primary workspace-scoped chat. Existing
-- duplicates are conservatively retained as side chats before the partial
-- unique index is introduced.
WITH ranked_primary_sessions AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workspaceId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS session_rank
  FROM "chat_sessions"
  WHERE "contextType" = 'workspace'
    AND "isPrimary" = true
    AND "workspaceId" IS NOT NULL
)
UPDATE "chat_sessions"
SET "isPrimary" = false
WHERE "id" IN (
  SELECT "id"
  FROM ranked_primary_sessions
  WHERE session_rank > 1
);

CREATE UNIQUE INDEX "chat_sessions_workspace_primary_unique"
ON "chat_sessions"("workspaceId")
WHERE "contextType" = 'workspace'
  AND "isPrimary" = true;
