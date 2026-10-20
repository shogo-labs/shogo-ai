// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The local SQLite database runs in WAL mode, and a file that cannot switch
 * stays usable in rollback-journal mode instead of failing startup.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { enableSqliteWal } from '../create-prisma-client'

const dirs: string[] = []

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-wal-'))
  dirs.push(dir)
  return join(dir, 'shogo.db')
}

function journalMode(file: string): string {
  const db = new Database(file, { readonly: true })
  try {
    return (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('enableSqliteWal', () => {
  it('switches a rollback-journal database to WAL', async () => {
    const file = tempDb()
    const db = new Database(file)
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    db.close()
    expect(journalMode(file)).toBe('delete')

    expect(await enableSqliteWal(`file:${file}`)).toBe(true)
    expect(journalMode(file)).toBe('wal')
  })

  it('is a no-op on a database already in WAL', async () => {
    const file = tempDb()
    expect(await enableSqliteWal(`file:${file}`)).toBe(true)
    expect(await enableSqliteWal(`file:${file}`)).toBe(true)
    expect(journalMode(file)).toBe('wal')
  })

  it('leaves an in-memory database alone', async () => {
    expect(await enableSqliteWal('file::memory:')).toBe(false)
  })

  it('reports false while another connection holds the file mid-write', async () => {
    const file = tempDb()
    const holder = new Database(file)
    holder.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    holder.run('BEGIN EXCLUSIVE')
    const original = console.warn
    console.warn = () => {}
    try {
      // The switch waits out busy_timeout (5s) before giving up.
      expect(await enableSqliteWal(`file:${file}`)).toBe(false)
    } finally {
      console.warn = original
      holder.run('ROLLBACK')
      holder.close()
    }
    expect(journalMode(file)).toBe('delete')
  }, 15_000)
})
