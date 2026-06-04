-- Scope machines to the user who paired them.
--
-- Adds Instance.userId (the owner, derived from the API key used to
-- register/heartbeat the machine — see resolveApiKey) and makes the
-- registry per-user: the unique key gains userId so two members can pair
-- the same hostname without colliding into one row, and the list
-- endpoints filter by userId.
--
-- Existing rows predate ownership tracking and their owner can't be
-- inferred, so we reset the presence registry. Active machines re-register
-- (owned) on their next heartbeat within ~60s; projects.preferredInstanceId
-- is ON DELETE SET NULL, so any pinned project preference simply clears.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN "userId" TEXT;

-- Reset legacy rows whose owner is unknowable (recreated, owned, on next heartbeat).
DELETE FROM "instances";

-- DropIndex
DROP INDEX "instances_workspaceId_hostname_key";

-- CreateIndex
CREATE UNIQUE INDEX "instances_workspaceId_userId_hostname_key" ON "instances"("workspaceId", "userId", "hostname");

-- CreateIndex
CREATE INDEX "instances_workspaceId_userId_idx" ON "instances"("workspaceId", "userId");
