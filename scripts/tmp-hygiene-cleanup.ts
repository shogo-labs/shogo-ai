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

/** Free bytes on the data volume (`df -k`, Available column), or null. */
function freeBytes(): number | null {
  const res = Bun.spawnSync(['df', '-k', DATA_DIR], { stdout: 'pipe', stderr: 'pipe' })
  if (res.exitCode !== 0) return null
  // macOS: Filesystem 1024-blocks Used Available Capacity iused ... — Available is col 4.
  const line = res.stdout.toString().trim().split('\n').pop() ?? ''
  const avail = Number(line.split(/\s+/)[3])
  return Number.isFinite(avail) ? avail * 1024 : null
}

function gb(bytes: number | null): string {
  return bytes == null ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

// Per-root so a slow or failing root can't sink the whole run, progress prints
// as it goes (a kill leaves the removed ones gone — re-running resumes), and
// `measureBytes: false` skips the ~1 s/`du` that made a full pass exceed the
// 5-min cap and get killed before it reached the folders that mattered.
const silent = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as unknown as Console
// Progress goes to stderr under --json so stdout stays a single JSON document.
const progress: (...args: unknown[]) => void = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a)

const index = loadCardIndex()
const roots = collectRoots(loadExternalProjectIds())
progress(`[cleanup] ${apply ? 'APPLIED' : 'DRY RUN'}: ${roots.length} roots; open ${index.open.length}, closed ${index.closed.length}`)

const dfBefore = freeBytes()
const removed: Array<{ path: string; card: string | null; root: string }> = []
const kept: Array<{ path: string; reason: string }> = []
const deferred: Array<{ path: string; reason: string }> = []
const errors: string[] = []
let looseFiles = 0
let looseDirs = 0

for (let i = 0; i < roots.length; i++) {
  const root = roots[i]
  const short = root.split('/').slice(-1)[0]
  try {
    const extras = await collectStrayWorktrees([root])
    const report = await sweepTmpHygiene({
      roots: [root],
      extraWorktrees: extras,
      loadCardBranches: async () => index,
      dryRun: !apply,
      measureBytes: false,
      logger: silent,
    })
    for (const entry of report.removed) removed.push({ path: entry.path, card: entry.card ?? null, root: short })
    for (const entry of report.kept) kept.push({ path: entry.path, reason: entry.reason })
    for (const entry of report.deferred) deferred.push({ path: entry.path, reason: entry.reason })
    looseFiles += report.loose.files
    looseDirs += report.loose.dirs
    errors.push(...report.errors)
    progress(`[cleanup] (${i + 1}/${roots.length}) ${short}: removed ${report.removed.length}, kept ${report.kept.length}, loose ${report.loose.files}f/${report.loose.dirs}d`)
    for (const entry of report.removed) progress(`    - ${entry.path}${entry.card ? ` [${entry.card}]` : ''}`)
  } catch (err: any) {
    const msg = `root ${short} failed: ${err?.message ?? err}`
    errors.push(msg)
    progress(`[cleanup] ${msg}`)
  }
}

const dfAfter = freeBytes()
const freed = dfBefore != null && dfAfter != null ? dfBefore - dfAfter : null
if (asJson) {
  console.log(JSON.stringify({ apply, roots: roots.length, removed, kept, deferred, loose: { files: looseFiles, dirs: looseDirs }, freedBytes: freed, errors }, null, 2))
} else {
  console.log(`[cleanup] DONE: removed ${removed.length} worktrees + ${looseFiles} loose files + ${looseDirs} loose dirs; kept ${kept.length}; deferred ${deferred.length}`)
  console.log(`[cleanup] df free: ${gb(dfBefore)} → ${gb(dfAfter)} (freed ~${gb(freed)})`)
  if (errors.length) console.log(`[cleanup] errors (${errors.length}): ${errors.slice(0, 10).join('; ')}${errors.length > 10 ? ` … +${errors.length - 10}` : ''}`)
}
