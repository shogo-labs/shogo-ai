// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fold every duplicate Personal workspace into the account's Personal
 * (SHO-285 Update 2).
 *
 * Prod already has accounts with a cloud Personal plus one hosted Personal per
 * desktop, and those desktops will not re-pair on their own. This walks the
 * database, picks the winner per account (the one `personalOwnerId` names, else
 * the oldest), rewrites every row that carries a duplicate's `workspaceId` into
 * the winner, moves the duplicate's workspace-root files to
 * `merged/<device>/`, and removes the empty row. Nothing is deleted.
 *
 * Idempotent: a second run finds one Personal per account and does nothing.
 *
 *   bun scripts/merge-duplicate-personals.ts --dry-run
 *   bun scripts/merge-duplicate-personals.ts
 */
import { prisma } from '../apps/api/src/lib/prisma'
import { mergeDuplicatePersonals } from '../apps/api/src/lib/machine-sync/personal-workspace'

const dryRun = process.argv.includes('--dry-run')

const results = await mergeDuplicatePersonals(prisma as any, {
  dryRun,
  log: (line) => console.log(line),
})

if (!results.length) {
  console.log('[personal] nothing to merge — one Personal per account')
} else {
  for (const result of results) {
    console.log(
      `[personal] ${dryRun ? 'would merge' : 'merged'} ${result.merged.length} duplicate(s) into ${result.winner} for user ${result.userId}`,
    )
  }
  console.log(`[personal] ${dryRun ? 'dry run: ' : ''}${results.length} account(s) affected`)
}
await prisma.$disconnect()
