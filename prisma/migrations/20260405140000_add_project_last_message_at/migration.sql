-- AlterTable
ALTER TABLE "projects" ADD COLUMN "lastMessageAt" TIMESTAMP(3);

-- Backfill: set lastMessageAt from the most recent chat session lastActiveAt
UPDATE "projects" p
SET "lastMessageAt" = sub."lastActiveAt"
FROM (
  SELECT cs."contextId", MAX(cs."lastActiveAt") AS "lastActiveAt"
  FROM "chat_sessions" cs
  WHERE cs."contextType" = 'project' AND cs."contextId" IS NOT NULL
  GROUP BY cs."contextId"
) sub
WHERE p.id = sub."contextId";
