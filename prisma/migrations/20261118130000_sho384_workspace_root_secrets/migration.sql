-- Migration: workspace_root_secrets (SHO-384).
--
-- A cloud `ws:` runtime cold-boots its root from `git archive HEAD`, which never
-- carries `.env`, `.env.local` or `.env.*` (git ignores them — see
-- DEFAULT_WORKSPACE_GITIGNORE), and the pod has no host in front of it to hold
-- the metal encrypted home archive SHO-382 added. The API keeps them instead:
-- one sealed blob per runtime key, so the pod can fetch its tokens after a cold
-- boot instead of coming up without them.
--
-- DDL only, no data work: the blob is opaque ciphertext (AES-256-GCM, key
-- derived per runtime key, runtime key bound as AAD) and there is nothing to
-- backfill — a runtime that has never exported simply has no row.

-- CreateTable
CREATE TABLE "workspace_root_secrets" (
    "id" TEXT NOT NULL,
    "runtimeKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_root_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_root_secrets_runtimeKey_key" ON "workspace_root_secrets"("runtimeKey");

-- CreateIndex
CREATE INDEX "workspace_root_secrets_workspaceId_idx" ON "workspace_root_secrets"("workspaceId");

-- AddForeignKey
-- The row belongs to the workspace, so every delete path (the CRUD route, the
-- admin route, the desktop local route, a workspace merge) drops the sealed
-- blob with it. A project-anchored runtime key (`ws:proj:<anchor>`) cannot be
-- turned back into a workspace id, so the owner is recorded rather than parsed.
ALTER TABLE "workspace_root_secrets" ADD CONSTRAINT "workspace_root_secrets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
