// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-time `.tmp` cleanup for a desktop install (SHO-607 §5).
 *
 * Runs the same rules as the runtime's scheduled sweep — branch/PR-ref card
 * matching, keep dirty/unpushed/recent, only inside `.tmp` — over every
 * Shogo-managed project dir and runtime root on this machine, plus the
 * worktrees agents registered *outside* `.tmp` (`.workspace-roots/…`, the data
 * dir) which the sweep deliberately never touches.
 *
 * Dry run by default; `--apply` actually removes. The card index comes from the
 * install's SQLite database, because this script may run while the API is
 * older than the branch-index route.
 *
 *   bun scripts/tmp-hygiene-cleanup.ts [--apply] [--json]
 */

import { Database } from 'bun:sqlite'
import { lstatSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import {
  sweepTmpHygiene,
  type CardBranchIndex,
  type CardBranchRef,
} from '../packages/agent-runtime/src/tmp-hygiene'

const DATA_DIR = join(process.env.HOME ?? '', 'Library/Application Support/Shogo/data')
const NOINDEX = join(DATA_DIR, 'workspaces.noindex')
const DB_PATH = join(DATA_DIR, 'shogo.db')
const WORKSPACE_ID = process.env.SHOGO_WORKSPACE_ID ?? 'ec94b79f-8c9f-4bea-b107-3b33d18e8a0d'

const apply = process.argv.includes('--apply')
const asJson = process.argv.includes('--json')

/** Project ids whose folder is the user's own checkout — never touched. */
function loadExternalProjectIds(): Set<string> {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const rows = db.query(`select id from projects where workingMode = 'external'`).all() as Array<{ id: string }>
    return new Set(rows.map((row) => row.id))
  } finally {
    db.close()
  }
}

function loadCardIndex(): CardBranchIndex {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const items = db
      .query(
        `select w.id, w.key, w.number, w.fields, w.completedAt, w.updatedAt, c.category
           from work_items w left join board_columns c on c.id = w.columnId
          where w.workspaceId = ? and w.archivedAt is null`,
      )
      .all(WORKSPACE_ID) as any[]
    const links = db
      .query(`select workItemId, refId, metadata from work_item_links where workspaceId = ? and kind = 'pr'`)
      .all(WORKSPACE_ID) as any[]

    const prsByItem = new Map<string, any[]>()
    for (const link of links) {
      const metadata = link.metadata ? JSON.parse(link.metadata) : {}
      const number = Number(metadata.number ?? link.refId)
      if (!Number.isInteger(number) || number <= 0) continue
      const list = prsByItem.get(link.workItemId) ?? []
      list.push({
        number,
        headRef: typeof metadata.headRef === 'string' ? metadata.headRef : null,
        headSha: typeof metadata.headSha === 'string' ? metadata.headSha : null,
        state: metadata.state === 'closed' ? 'closed' : 'open',
        merged: metadata.merged === true,
      })
      prsByItem.set(link.workItemId, list)
    }

    const cutoff = Date.now() - 90 * 24 * 60 * 60_000
    const index: CardBranchIndex = { open: [], closed: [] }
    for (const item of items) {
      const fields = item.fields ? JSON.parse(item.fields) : {}
      const branch = typeof fields.branch === 'string' && fields.branch.trim() ? fields.branch.trim() : null
      const prs = (prsByItem.get(item.id) ?? []).sort((a, b) => a.number - b.number)
      if (!branch && prs.length === 0) continue
      const view: CardBranchRef = { key: item.key, number: item.number, branch, prs }
      const closed = item.category === 'done' || item.category === 'dismissed'
      if (!closed) {
        index.open.push(view)
        continue
      }
      const closedAt = Date.parse(item.completedAt ?? item.updatedAt ?? '')
      if (Number.isFinite(closedAt) && closedAt < cutoff) continue
      index.closed.push(view)
    }
    return index
  } finally {
    db.close()
  }
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectRoots(externalIds: Set<string>): string[] {
  const roots: string[] = []
  const isExternal = (name: string) =>
    externalIds.has(name) || (name.startsWith('proj-') && externalIds.has(name.slice('proj-'.length)))
  for (const parent of [join(NOINDEX, '.workspace-roots'), NOINDEX]) {
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const path = join(parent, name)
      if (!isRealDir(path)) continue
      if (isExternal(name)) continue
      if (!isRealDir(join(path, '.tmp'))) continue
      // Only a Shogo-owned tree: never follow a folder-linked project.
      if (!path.startsWith(NOINDEX)) continue
      roots.push(resolve(path))
    }
  }
  return [...new Set(roots)]
}

/** Worktrees these repos registered outside `.tmp`, under the Shogo data dir. */
async function collectStrayWorktrees(roots: string[]): Promise<Array<{ repoDir: string; path: string }>> {
  const strays: Array<{ repoDir: string; path: string }> = []
  for (const root of roots) {
    const gitDir = join(root, '.git')
    if (!isRealDir(gitDir)) continue
    const listed = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (listed.exitCode !== 0) continue
    const output = listed.stdout.toString()
    for (const block of output.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (!path) continue
      const abs = resolve(path)
      if (abs === root) continue
      if (abs.startsWith(join(root, '.tmp') + '/')) continue
      // Per-chat worktrees belong to a running feature, not to scratch.
      if (abs.includes('/.worktrees/') || abs.includes('/.shogo-worktrees/')) continue
      if (!abs.startsWith(DATA_DIR)) continue
      strays.push({ repoDir: root, path: abs })
    }
  }
  return strays
}

const index = loadCardIndex()
const roots = collectRoots(loadExternalProjectIds())
const extras = await collectStrayWorktrees(roots)

const report = await sweepTmpHygiene({
  roots,
  extraWorktrees: extras,
  loadCardBranches: async () => index,
  dryRun: !apply,
})

const bytes = report.removed.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) + report.loose.bytes
if (asJson) {
  console.log(JSON.stringify({ apply, roots: roots.length, strays: extras.length, report }, null, 2))
} else {
  console.log(`[cleanup] ${apply ? 'APPLIED' : 'DRY RUN'}: ${roots.length} roots, ${extras.length} stray worktrees`)
  console.log(`[cleanup] open cards: ${index.open.length}, closed cards: ${index.closed.length}`)
  console.log(`[cleanup] worktrees removed: ${report.removed.length} (${(bytes / 1024 ** 3).toFixed(2)} GB)`)
  for (const entry of report.removed) console.log(`  - ${entry.path}${entry.card ? ` [${entry.card}]` : ''}`)
  console.log(`[cleanup] loose files removed: ${report.loose.files}, loose dirs: ${report.loose.dirs}`)
  console.log(`[cleanup] kept: ${report.kept.length}`)
  for (const entry of report.kept) console.log(`  · ${entry.path} — ${entry.reason}`)
  console.log(`[cleanup] deferred: ${report.deferred.length}`)
  for (const entry of report.deferred) console.log(`  … ${entry.path} — ${entry.reason}`)
  if (report.errors.length) console.log(`[cleanup] errors: ${report.errors.join('; ')}`)
}
