// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Consistent capture of a project's WRITABLE RUNTIME STATE — the SQLite
 * database plus any upload directories — for durable backup.
 *
 * Why this is not just `tar prisma/dev.db prisma/dev.db-wal`: SQLite's own
 * corruption guide names that exact pattern as a cause of corruption —
 * "Systems that run automatic backups in the background might try to make a
 * backup copy of an SQLite database file while it is in the middle of a
 * transaction. The backup copy then might contain some old and some new
 * content, and thus be corrupt." Copying files is only safe when no
 * transaction is in progress, which a periodic exporter cannot guarantee
 * against a live app. The sanctioned alternatives are the online backup API,
 * `VACUUM INTO`, and `sqlite3_rsync`; `bun:sqlite` exposes no backup API, so
 * this module uses `VACUUM INTO`, whose output is documented to be a
 * transactionally consistent snapshot of the source.
 *
 * Two consequences shape the rest of this file:
 *
 *   - A `VACUUM INTO` snapshot has no WAL, so the sidecars are deliberately
 *     NOT archived. On the restore side that makes {@link clearSqliteSidecars}
 *     mandatory: a `-wal` left behind by the rootfs template belongs to a
 *     different database, and SQLite would replay it over the restored one.
 *
 *   - Snapshotting is not free (it rewrites the database), so
 *     {@link writableStateTag} exists to answer "did anything change?" without
 *     doing any of the work. An idle project should cost a stat, not a VACUUM.
 *
 * @see https://www.sqlite.org/howtocorrupt.html
 * @see https://www.sqlite.org/lang_vacuum.html
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The project database. Snapshotted, never copied. */
export const SQLITE_DB_REL = 'prisma/dev.db'

/**
 * WAL/shared-memory siblings. Never archived: the `-shm` file holds no
 * permanent data (SQLite recreates it during WAL recovery) and a `-wal` only
 * means anything next to the exact database it was written for.
 */
export const SQLITE_SIDECAR_RELS = ['prisma/dev.db-wal', 'prisma/dev.db-shm'] as const

/** Upload directories — opaque user media, safe to archive as plain files. */
export const WRITABLE_DIR_RELS = ['uploads', 'public/uploads', 'storage'] as const

/**
 * Legacy flat list, still used by the published-app data path
 * (`/agent/published-data-archive`), which copies files directly. Kept here so
 * both mechanisms agree on what "writable state" means.
 */
export const WRITABLE_STATE_PATHS: string[] = [
  SQLITE_DB_REL,
  ...SQLITE_SIDECAR_RELS,
  ...WRITABLE_DIR_RELS,
]

/**
 * Cached read-only connections, keyed by database path.
 *
 * Required for correctness, not speed: `PRAGMA data_version` reports commits
 * made by OTHER connections since THIS connection was opened, so a fresh
 * connection per call always reads the same baseline and would never register
 * a change. The cached connection is invalidated when the inode changes, which
 * is what `prisma migrate reset` does.
 */
const dbHandles = new Map<string, { db: { query: Function; close: Function }; ino: string }>()

/** Close cached handles. For tests and clean shutdown. */
export function closeWritableStateHandles(): void {
  for (const h of dbHandles.values()) {
    try {
      h.db.close()
    } catch {}
  }
  dbHandles.clear()
}

/**
 * Change signature for the database: inode, size, nanosecond mtime, and the
 * SQLite commit counter.
 *
 * The redundancy is deliberate and one-directional. A FALSE "changed" costs an
 * unnecessary upload; a false "unchanged" silently stops backing the project up,
 * which is the failure this whole subsystem exists to prevent. So every signal
 * that can only advance is included, and anything unreadable degrades to the
 * filesystem metadata rather than being dropped.
 */
function sqliteTag(dbPath: string): string | null {
  let st: { ino: bigint; size: bigint; mtimeNs: bigint }
  try {
    st = statSync(dbPath, { bigint: true }) as unknown as {
      ino: bigint
      size: bigint
      mtimeNs: bigint
    }
  } catch {
    // Gone (or never existed). Drop any handle we were holding open for it so
    // a database that is deleted and not recreated does not pin an fd forever.
    const orphan = dbHandles.get(dbPath)
    if (orphan) {
      try {
        orphan.db.close()
      } catch {}
      dbHandles.delete(dbPath)
    }
    return null
  }
  const fsPart = `${st.ino}:${st.size}:${st.mtimeNs}`

  let handle = dbHandles.get(dbPath)
  if (handle && handle.ino !== String(st.ino)) {
    try {
      handle.db.close()
    } catch {}
    dbHandles.delete(dbPath)
    handle = undefined
  }
  if (!handle) {
    try {
      const { Database } = require('bun:sqlite')
      // `readwrite`, not `readonly` — see {@link openForSnapshot}.
      const db = new Database(dbPath, { readwrite: true })
      handle = { db, ino: String(st.ino) }
      dbHandles.set(dbPath, handle)
    } catch {
      // Not a readable SQLite file (yet). Metadata alone still advances on write.
      return fsPart
    }
  }

  try {
    const row = handle.db.query('PRAGMA data_version').get() as { data_version?: number } | null
    return `${fsPart}:${row?.data_version ?? 'x'}`
  } catch {
    return fsPart
  }
}

/**
 * Upload directories walked to at most this many entries. Past the budget the
 * tag stops being a fingerprint and starts being "assume changed" — expensive
 * but never wrong, which is the correct direction to fail.
 */
const TREE_ENTRY_BUDGET = 5000

/** Size/mtime fingerprint of a directory tree, or null when it does not exist. */
function treeTag(root: string): string | null {
  if (!existsSync(root)) return null
  const parts: string[] = []
  const stack = [root]
  let seen = 0
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (++seen > TREE_ENTRY_BUDGET) return `overflow:${Date.now()}`
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const st = statSync(full, { bigint: true }) as unknown as {
          size: bigint
          mtimeNs: bigint
        }
        parts.push(`${full}:${st.size}:${st.mtimeNs}`)
      } catch {}
    }
  }
  parts.sort()
  return parts.join('\n')
}

/**
 * A short, stable fingerprint of everything {@link packWritableState} would
 * archive, computed without snapshotting or packing anything.
 *
 * Returns null when the project has no writable state at all. Callers treat an
 * unchanged tag as "skip the export entirely"; see the one-directional safety
 * argument on {@link sqliteTag}.
 */
export function writableStateTag(workspaceDir: string): string | null {
  const parts: string[] = []

  const db = sqliteTag(join(workspaceDir, SQLITE_DB_REL))
  if (db) parts.push(`db:${db}`)

  // The WAL is not archived, but it holds committed data that the snapshot
  // WILL include, so it has to count as a change.
  //
  // The `-shm` deliberately does NOT count. It is a rebuildable index holding
  // no permanent data, and reading the database recreates it — so folding it
  // in would let the tag change as a side effect of computing the tag, and an
  // idle project would never register as unchanged.
  try {
    const st = statSync(join(workspaceDir, 'prisma/dev.db-wal'), { bigint: true }) as unknown as {
      size: bigint
      mtimeNs: bigint
    }
    parts.push(`wal:${st.size}:${st.mtimeNs}`)
  } catch {}

  for (const rel of WRITABLE_DIR_RELS) {
    const t = treeTag(join(workspaceDir, rel))
    if (t !== null) parts.push(`${rel}:${t}`)
  }

  if (parts.length === 0) return null
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)
}

/**
 * Open a database for reading in a way that also works on a cleanly-closed
 * WAL database.
 *
 * Counter-intuitively this must NOT be `readonly`. A WAL database is read
 * through its shared-memory index, and when the `-shm` file is absent SQLite
 * has to rebuild it — which needs write access to the directory. A read-only
 * handle therefore fails outright with SQLITE_CANTOPEN.
 *
 * That is not an exotic state: it is exactly what a workspace looks like
 * immediately after a cold-boot hydrate, where the archive carries `dev.db`
 * with no sidecars and {@link clearSqliteSidecars} removes any leftovers. A
 * read-only handle would have failed the very first export after every cold
 * boot — the projects that most need a backup.
 *
 * Nothing here writes to the database; the handle is read-write only so
 * SQLite may materialise its index.
 */
function openForSnapshot(dbPath: string): { exec: Function; close: Function } {
  const { Database } = require('bun:sqlite')
  return new Database(dbPath, { readwrite: true })
}

/**
 * Write a transactionally consistent copy of `dbPath` to `destPath` using
 * `VACUUM INTO`. Throws if the source is not a usable SQLite database or the
 * snapshot cannot be produced — callers must NOT fall back to copying the
 * file, which is the corruption case this exists to avoid.
 *
 * `VACUUM INTO` needs free space on the order of the database size and refuses
 * to overwrite an existing file, so `destPath` must be a fresh path.
 */
export function snapshotSqlite(dbPath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true })
  const src = openForSnapshot(dbPath)
  try {
    // Ride out a writer's short exclusive lock instead of failing the whole
    // export; a periodic exporter that gives up on the first busy database
    // would skip exactly the projects that are being actively used.
    src.exec('PRAGMA busy_timeout = 5000')
    src.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
  } finally {
    try {
      src.close()
    } catch {}
  }
}

/** Result of packing writable state. `paths` is what the archive contains. */
export interface WritableStatePack {
  paths: string[]
  tag: string | null
}

/**
 * Pack the project's writable state into `outPath` as a gzipped tar rooted at
 * the workspace (entries like `prisma/dev.db`, `uploads/…`).
 *
 * Returns null when there is nothing to persist — distinct from an empty
 * archive, which would be an invitation to overwrite a real backup with
 * nothing.
 *
 * The database comes from a snapshot in `stageDir` while upload directories
 * come straight from the workspace, so the archive is assembled from two roots
 * in one `tar` invocation (repeated `-C`). Staging outside the workspace is
 * deliberate: writing a scratch file into a live workspace would trip the
 * preview file watcher and trigger a rebuild on every export cycle.
 */
export async function packWritableState(opts: {
  workspaceDir: string
  stageDir: string
  outPath: string
  /** Tag already computed by the caller; see the ordering note below. */
  tag?: string | null
}): Promise<WritableStatePack | null> {
  const { workspaceDir, stageDir, outPath } = opts

  const dbPath = join(workspaceDir, SQLITE_DB_REL)
  const hasDb = existsSync(dbPath)
  const dirs = WRITABLE_DIR_RELS.filter((rel) => existsSync(join(workspaceDir, rel)))
  if (!hasDb && dirs.length === 0) return null

  // The tag MUST describe state at or before what the archive captures, never
  // after. Tagging afterwards would attach a fingerprint that already includes
  // a write this archive does not contain, and the next cycle would answer
  // "unchanged" and never back that write up. Erring early is merely a
  // redundant export; erring late is silent data loss.
  const tag = opts.tag !== undefined ? opts.tag : writableStateTag(workspaceDir)

  const args = ['-czf', outPath]
  const paths: string[] = []
  if (hasDb) {
    snapshotSqlite(dbPath, join(stageDir, SQLITE_DB_REL))
    args.push('-C', stageDir, SQLITE_DB_REL)
    paths.push(SQLITE_DB_REL)
  }
  if (dirs.length) {
    args.push('-C', workspaceDir, ...dirs)
    paths.push(...dirs)
  }

  const proc = Bun.spawn(['tar', ...args], { stdout: 'ignore', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`tar exited ${code}: ${stderr.trim().slice(0, 400)}`)

  return { paths, tag }
}

/**
 * Delete `prisma/dev.db-wal` / `-shm` if present, returning what was removed.
 *
 * Restoring a snapshot means installing a database that never had a WAL. Any
 * `-wal` still sitting next to it belongs to a DIFFERENT database — typically
 * the rootfs template's — and SQLite would replay it over the restored file on
 * the next open, corrupting it or silently resurrecting foreign rows.
 */
export function clearSqliteSidecars(workspaceDir: string): string[] {
  const removed: string[] = []
  for (const rel of SQLITE_SIDECAR_RELS) {
    const p = join(workspaceDir, rel)
    try {
      if (existsSync(p)) {
        unlinkSync(p)
        removed.push(rel)
      }
    } catch {}
  }
  return removed
}

/**
 * True when `entries` describe a database snapshot: the database is present
 * and its WAL is not. That is precisely the archive shape
 * {@link packWritableState} produces, and the condition under which stale
 * sidecars must be cleared after extraction.
 *
 * A legacy archive that carries `dev.db` together with its own `-wal` is left
 * alone — there the two belong together.
 */
export function archiveNeedsSidecarClear(entries: Iterable<string>): boolean {
  let hasDb = false
  let hasWal = false
  for (const raw of entries) {
    const e = raw.replace(/^\.\//, '')
    if (e === SQLITE_DB_REL) hasDb = true
    else if (e === 'prisma/dev.db-wal') hasWal = true
  }
  return hasDb && !hasWal
}

/**
 * The archive entries {@link archiveNeedsSidecarClear} can act on.
 *
 * A caller reading a tar listing as it streams uses this to keep the handful of
 * relevant paths and discard the rest — a large project lists hundreds of
 * thousands of files, and holding all of them would defeat the point of
 * streaming. Kept next to the decision it feeds so the two cannot drift.
 */
export const SQLITE_SIDECAR_ENTRY = /(^|\/)prisma\/dev\.db(-wal)?$/
