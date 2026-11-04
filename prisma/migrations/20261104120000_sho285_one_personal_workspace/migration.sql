-- One Personal workspace per account (SHO-285 Update 2).
--
-- A user with a cloud account and two desktops used to end up with three
-- Personals: the cloud's (created at signup) plus one per desktop (seeded by
-- `bootstrapLocalDatabase` and pushed up as a hosted workspace). The rule is now
-- enforced by the database instead of by a check somebody has to remember.
ALTER TABLE "workspaces" ADD COLUMN "personalOwnerId" TEXT;

-- Backfill: each user's oldest Personal becomes *the* Personal. Older
-- duplicates keep a null owner, so they are not blocked by the unique index and
-- the merge (which rewrites their rows into the winner and deletes the empty
-- row) can still find them by `kind = 'personal'`.
UPDATE "workspaces" w
   SET "personalOwnerId" = winner."ownerId"
  FROM (
        SELECT DISTINCT ON (m."userId") m."userId" AS "ownerId", w2."id" AS "workspaceId"
          FROM "workspaces" w2
          JOIN "members" m ON m."workspaceId" = w2."id" AND m."role" = 'owner'
         WHERE w2."kind" = 'personal'
         ORDER BY m."userId", w2."createdAt" ASC, w2."id" ASC
       ) winner
 WHERE w."id" = winner."workspaceId";

CREATE UNIQUE INDEX "workspaces_personalOwnerId_key" ON "workspaces"("personalOwnerId");

-- Background jobs run where they were requested (SHO-285 Update 2): null means
-- the cloud, an `instances.id` means that paired desktop. Exactly one scheduler
-- fires each job — the cloud runs the null ones, each desktop runs its own.
ALTER TABLE "agent_schedules" ADD COLUMN "runOnInstanceId" TEXT;

CREATE INDEX "agent_schedules_runOnInstanceId_idx" ON "agent_schedules"("runOnInstanceId");

ALTER TABLE "agent_configs" ADD COLUMN "runOnInstanceId" TEXT;

-- A job that already exists in a hosted workspace keeps running on that desktop
-- (Part 1's rule), so pin it there rather than letting the cloud pick it up.
UPDATE "agent_schedules" s
   SET "runOnInstanceId" = w."hostInstanceId"
  FROM "workspaces" w
 WHERE w."id" = s."workspaceId"
   AND w."hostInstanceId" IS NOT NULL;

UPDATE "agent_configs" ac
   SET "runOnInstanceId" = w."hostInstanceId"
  FROM "projects" p
  JOIN "workspaces" w ON w."id" = p."workspaceId"
 WHERE p."id" = ac."projectId"
   AND w."hostInstanceId" IS NOT NULL;
