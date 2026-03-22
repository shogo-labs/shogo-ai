// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SQLite-Based Session Persistence
 *
 * Persists session state in a single SQLite database file within the
 * agent workspace. The file lives at {workspaceDir}/sessions.db and is
 * automatically included in the S3 sync, so sessions survive pod restarts.
 *
 * Advantages over file-per-session:
 * - Single file = atomic operations, no partial-write corruption
 * - WAL mode for concurrent read/write
 * - Efficient queries for loadAll/delete
 * - Plays well with S3 archive sync (one file vs N files)
 */

import { Database } from 'bun:sqlite'
import { join } from 'path'
import type { SessionPersistence, SerializedSession } from './session-manager'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`

export class SqliteSessionPersistence implements SessionPersistence {
  private db: Database

  constructor(workspaceDir: string) {
    const dbPath = join(workspaceDir, 'sessions.db')
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
  }

  async save(id: string, session: SerializedSession): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO sessions (id, data, updated_at) VALUES (?, ?, ?)'
    )
    stmt.run(id, JSON.stringify(session), Math.floor(Date.now() / 1000))
  }

  async load(id: string): Promise<SerializedSession | null> {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as
      | { data: string }
      | null
    if (!row) return null

    try {
      return JSON.parse(row.data)
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async loadAll(): Promise<SerializedSession[]> {
    const rows = this.db.prepare('SELECT data FROM sessions').all() as Array<{ data: string }>
    const sessions: SerializedSession[] = []
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data)
        if (data.id) sessions.push(data)
      } catch {
        // skip corrupt rows
      }
    }
    return sessions
  }

  /** Close the database connection (call on shutdown) */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.db.close()
    } catch {
      // already closed
    }
  }
}
