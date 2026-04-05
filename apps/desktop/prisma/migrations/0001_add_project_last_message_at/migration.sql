-- AlterTable
ALTER TABLE "projects" ADD COLUMN "lastMessageAt" DATETIME;

-- Backfill: set lastMessageAt from the most recent chat session lastActiveAt
UPDATE "projects"
SET "lastMessageAt" = (
  SELECT MAX(cs."lastActiveAt")
  FROM "chat_sessions" cs
  WHERE cs."contextType" = 'project' AND cs."contextId" = "projects"."id"
)
WHERE EXISTS (
  SELECT 1 FROM "chat_sessions" cs
  WHERE cs."contextType" = 'project' AND cs."contextId" = "projects"."id"
);
