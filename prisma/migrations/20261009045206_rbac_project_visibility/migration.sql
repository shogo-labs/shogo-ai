-- Collapse duplicate workspace-scoped memberships, keeping the highest role and
-- preserving the billing-admin flag from any duplicate. Must run before the
-- partial unique indexes below are created.
UPDATE "members" m SET "isBillingAdmin" = true
WHERE m."projectId" IS NULL AND m."isBillingAdmin" = false AND EXISTS (
  SELECT 1 FROM "members" m2
  WHERE m2."userId" = m."userId" AND m2."workspaceId" = m."workspaceId"
    AND m2."projectId" IS NULL AND m2."isBillingAdmin" = true
);
DELETE FROM "members" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (
      PARTITION BY "userId", "workspaceId"
      ORDER BY CASE "role" WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, "createdAt"
    ) AS rn
    FROM "members" WHERE "projectId" IS NULL
  ) ranked WHERE rn > 1
);

-- Collapse duplicate project-scoped memberships the same way.
DELETE FROM "members" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (
      PARTITION BY "userId", "projectId"
      ORDER BY CASE "role" WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, "createdAt"
    ) AS rn
    FROM "members" WHERE "projectId" IS NOT NULL
  ) ranked WHERE rn > 1
);

-- Project roles are admin / member / viewer; fold project-level owner into admin.
UPDATE "members" SET "role" = 'admin' WHERE "projectId" IS NOT NULL AND "role" = 'owner';

-- CreateEnum
CREATE TYPE "ProjectVisibility" AS ENUM ('workspace', 'restricted');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "visibility" "ProjectVisibility" NOT NULL DEFAULT 'workspace';

-- CreateIndex
CREATE UNIQUE INDEX "members_workspace_scope_key" ON "members"("userId", "workspaceId") WHERE ("projectId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "members_project_scope_key" ON "members"("userId", "projectId") WHERE ("projectId" IS NOT NULL);
