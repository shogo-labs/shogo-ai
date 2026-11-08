// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * New project databases default to SQLite's WAL journal.
 *
 * A project's `prisma/dev.db` is created by `prisma db push`, which leaves it
 * in the rollback-journal (`delete`) mode. In that mode a write locks the
 * whole file against readers, so the preview server, the agent's own queries
 * and a publish export reading the same file block each other ("database is
 * locked"). WAL lets readers and the one writer run side by side.
 *
 * `journal_mode=WAL` is stored in the file header, so switching it once,
 * right after the push that created the file, is enough for every later
 * connection. Everything that copies a project database already handles the
 * `-wal` sidecar: publish checkpoints before it archives, metal snapshots
 * carry it (writable-state.ts), and the S3 sync uploads it.
 */
import { isAbsolute, join, resolve } from 'node:path'

export type SqliteWalResult = 'wal' | 'already-wal' | 'missing' | 'unsupported' | 'failed'

/** The SQLite file a `file:` URL points at, or null for any other URL. */
export function sqliteFileFromUrl(url: string | undefined, cwd: string): string | null {
  if (!url || !url.startsWith('file:')) return null
  const raw = url.slice('file:'.length).split('?')[0]
  if (!raw || raw === ':memory:') return null
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

/**
 * The files a `prisma db push` in `cwd` may just have written: the
 * `DATABASE_URL` it ran with when that is a file URL (none for any other
 * URL), otherwise the conventional `prisma/dev.db`, then a root `dev.db` from
 * an older config. Existence is left to `ensureSqliteWal`.
 */
export function pushedSqliteFiles(cwd: string, env?: NodeJS.ProcessEnv): string[] {
  const url = env?.DATABASE_URL
  if (url) {
    const file = sqliteFileFromUrl(url, cwd)
    return file ? [file] : []
  }
  return [join(cwd, 'prisma', 'dev.db'), join(cwd, 'dev.db')]
}

type SqliteModule = {
  Database: new (path: string, opts?: { readwrite?: boolean; create?: boolean }) => {
    query(sql: string): { get(): unknown }
    close(): void
  }
}

function loadBunSqlite(): SqliteModule | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return null
  // Kept out of the bundler's sight: `bun:sqlite` only exists under Bun.
  const id = 'bun:sqlite'
  try {
    return require(id) as SqliteModule
  } catch {
    return null
  }
}

/**
 * Put `dbPath` in WAL mode. Best effort: a database another process holds
 * open may refuse the switch (`SQLITE_BUSY`), and that must never fail the
 * push that called this.
 */
export function ensureSqliteWal(dbPath: string): SqliteWalResult {
  const sqlite = loadBunSqlite()
  if (!sqlite) return 'unsupported'
  let db: InstanceType<SqliteModule['Database']> | null = null
  try {
    db = new sqlite.Database(dbPath, { readwrite: true, create: false })
  } catch {
    return 'missing'
  }
  try {
    const current = (db.query('PRAGMA journal_mode').get() as { journal_mode?: string } | null)
      ?.journal_mode?.toLowerCase()
    if (current === 'wal') return 'already-wal'
    const after = (db.query('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | null)
      ?.journal_mode?.toLowerCase()
    return after === 'wal' ? 'wal' : 'failed'
  } catch {
    return 'failed'
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}
