// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSqliteWal, pushedSqliteFiles, sqliteFileFromUrl } from '../sqlite-wal'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shogo-sqlite-wal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A database the way `prisma db push` leaves it: rollback journal. */
function makeDeleteModeDb(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec('CREATE TABLE t (x INTEGER)')
  db.close()
}

function journalMode(path: string): string {
  const db = new Database(path)
  try {
    return (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
  } finally {
    db.close()
  }
}

describe('ensureSqliteWal', () => {
  test('switches a rollback-journal database to WAL, and it stays WAL for the next connection', () => {
    const path = join(dir, 'dev.db')
    makeDeleteModeDb(path)
    expect(journalMode(path)).toBe('delete')

    expect(ensureSqliteWal(path)).toBe('wal')
    expect(journalMode(path)).toBe('wal')
  })

  test('is a no-op on a database that is already WAL', () => {
    const path = join(dir, 'dev.db')
    makeDeleteModeDb(path)
    ensureSqliteWal(path)
    expect(ensureSqliteWal(path)).toBe('already-wal')
  })

  test('does not create a database that does not exist', () => {
    expect(ensureSqliteWal(join(dir, 'nope.db'))).toBe('missing')
  })
})

describe('pushedSqliteFiles', () => {
  test('follows a file: DATABASE_URL, absolute or relative to the project', () => {
    expect(pushedSqliteFiles(dir, { DATABASE_URL: 'file:/abs/dev.db' })).toEqual(['/abs/dev.db'])
    expect(pushedSqliteFiles(dir, { DATABASE_URL: 'file:./prisma/dev.db' })).toEqual([join(dir, 'prisma/dev.db')])
  })

  test('ignores a non-SQLite DATABASE_URL instead of guessing a file', () => {
    expect(pushedSqliteFiles(dir, { DATABASE_URL: 'postgres://u:p@h/db' })).toEqual([])
  })

  test('falls back to prisma/dev.db, then a root dev.db, when the push ran without a DATABASE_URL', () => {
    expect(pushedSqliteFiles(dir, {})).toEqual([join(dir, 'prisma/dev.db'), join(dir, 'dev.db')])
  })

  test('sqliteFileFromUrl drops query params and in-memory URLs', () => {
    expect(sqliteFileFromUrl('file:./dev.db?connection_limit=1', dir)).toBe(join(dir, 'dev.db'))
    expect(sqliteFileFromUrl('file::memory:', dir)).toBeNull()
  })
})
