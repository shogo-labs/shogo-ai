// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off backfill: copy existing Slack installs and account links into the
 * provider-generic `chat_installations` / `chat_identity_links` tables added in
 * migration 20260930180000_add_chat_installations.
 *
 * Why a script and not a migration step
 * -------------------------------------
 * The tables are DDL, which logical replication does NOT carry, so the
 * migration runs in every region's `migrate deploy`. The copy is DML (INSERT),
 * which IS replicated. Run inside the migration it would insert the same
 * `slack-<id>` primary keys in both regions and stop replication on
 * `insert_exists`. See scripts/backfill-workspace-home-region.ts for the same
 * pattern.
 *
 * So: run this ONCE against the US primary after the release. The rows then
 * replicate out to EU like any other.
 *
 * Until it has run, a pre-existing Slack workspace has no `chat_installations`
 * row, so it cannot be switched to Slack-backed team chat (the single-agent
 * Slack flow keeps working off `slack_workspace_installations`).
 *
 * The Slack bot token is already encrypted; it is carried over as-is and read
 * as a bare token by the installation loader.
 *
 * Idempotent: `ON CONFLICT DO NOTHING`, so re-runs are safe no-ops.
 *
 * Usage:
 *   bun scripts/backfill-chat-installations.ts            # dry run (default)
 *   bun scripts/backfill-chat-installations.ts --apply    # execute the INSERTs
 *   bun scripts/backfill-chat-installations.ts --apply --force  # skip region guard
 */

import { prisma } from '../apps/api/src/lib/prisma'

const PRIMARY_REGION = 'us-ashburn-1'

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const FORCE = args.has('--force')

const INSTALLATIONS_SELECT = `
  SELECT 'slack-' || s."id", s."workspaceId", 'slack', s."slackTeamId", s."slackTeamName", s."botUserId", s."botAccessTokenEncrypted",
         jsonb_build_object('defaultProjectId', s."defaultProjectId"), s."createdAt", s."updatedAt"
  FROM "slack_workspace_installations" s`

const LINKS_SELECT = `
  SELECT 'slack-' || l."id", 'slack', l."slackTeamId", l."slackUserId", l."shogoUserId", l."createdAt", l."updatedAt"
  FROM "slack_user_links" l`

const INSTALLATIONS_INSERT = `INSERT INTO "chat_installations" ("id", "workspaceId", "provider", "externalTenantId", "tenantName", "botUserId", "tokensEncrypted", "config", "createdAt", "updatedAt")${INSTALLATIONS_SELECT}
  ON CONFLICT DO NOTHING`

const LINKS_INSERT = `INSERT INTO "chat_identity_links" ("id", "provider", "externalTenantId", "externalUserId", "userId", "createdAt", "updatedAt")${LINKS_SELECT}
  ON CONFLICT DO NOTHING`

async function count(sql: string): Promise<number> {
  const [{ count }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(sql)
  return Number(count)
}

async function main() {
  // Region guard: run in the primary so the INSERTs replicate out from a single
  // writer. Running it in another region would write the same keys there and
  // conflict with the primary's copy.
  const region = process.env.REGION_ID || null
  if (APPLY && region && region !== PRIMARY_REGION && !FORCE) {
    console.error(
      `[chat-installations-backfill] Refusing to apply: REGION_ID=${region} is not the primary ${PRIMARY_REGION}.\n` +
        `Run this once against the US primary (its writes replicate to EU), or pass --force if you really mean to.`,
    )
    process.exit(1)
  }

  const pendingInstalls = await count(
    `SELECT COUNT(*)::bigint AS count FROM "slack_workspace_installations" s
     WHERE NOT EXISTS (SELECT 1 FROM "chat_installations" c WHERE c."id" = 'slack-' || s."id")`,
  )
  const pendingLinks = await count(
    `SELECT COUNT(*)::bigint AS count FROM "slack_user_links" l
     WHERE NOT EXISTS (SELECT 1 FROM "chat_identity_links" c WHERE c."id" = 'slack-' || l."id")`,
  )
  console.log(`[chat-installations-backfill] slack installs to copy: ${pendingInstalls}`)
  console.log(`[chat-installations-backfill] slack account links to copy: ${pendingLinks}`)

  if (pendingInstalls === 0 && pendingLinks === 0) {
    console.log('[chat-installations-backfill] nothing to do.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log('\n[chat-installations-backfill] dry run - re-run with --apply to copy these rows.')
    process.exit(0)
  }

  const installs = await prisma.$executeRawUnsafe(INSTALLATIONS_INSERT)
  const links = await prisma.$executeRawUnsafe(LINKS_INSERT)
  console.log(`[chat-installations-backfill] applied. installs inserted: ${installs}, links inserted: ${links}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[chat-installations-backfill] failed:', err)
  process.exit(1)
})
