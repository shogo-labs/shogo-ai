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
import type { Message } from '@mariozechner/pi-ai'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`

const SUBAGENT_TRANSCRIPTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS subagent_transcripts (
    agent_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    description TEXT,
    messages TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`

export class SqliteSessionPersistence implements SessionPersistence {
  private db!: Database

  constructor(workspaceDir: string) {
    const dbPath = join(workspaceDir, 'sessions.db')
    // Retry opening the database — a previous process may still hold the lock
    // briefly after being killed (WAL checkpoint, OS flush, etc.)
    const MAX_RETRIES = 8
    const BASE_DELAY_MS = 250
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.db = new Database(dbPath)
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec(SCHEMA)
        this.db.exec(SUBAGENT_TRANSCRIPTS_SCHEMA)
        lastError = null
        break
      } catch (err: any) {
        lastError = err
        if (err?.code === 'SQLITE_BUSY' && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * attempt
          console.warn(`[SqliteSessionPersistence] Database locked, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
          // Synchronous sleep in constructor — acceptable during one-time init
          Bun.sleepSync(delay)
          continue
        }
        throw err
      }
    }
    if (lastError) throw lastError
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

  // ---------------------------------------------------------------------------
  // Subagent Transcript Persistence
  // ---------------------------------------------------------------------------

  async saveSubagentTranscript(
    agentId: string,
    sessionId: string,
    agentType: string,
    description: string,
    messages: Message[],
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(
      `INSERT OR REPLACE INTO subagent_transcripts
       (agent_id, session_id, agent_type, description, messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, sessionId, agentType, description, JSON.stringify(messages), now, now)
  }

  async loadSubagentTranscript(
    agentId: string,
  ): Promise<{ agentType: string; description: string; messages: Message[] } | null> {
    const row = this.db.prepare(
      'SELECT agent_type, description, messages FROM subagent_transcripts WHERE agent_id = ?',
    ).get(agentId) as { agent_type: string; description: string; messages: string } | null
    if (!row) return null
    try {
      return {
        agentType: row.agent_type,
        description: row.description,
        messages: JSON.parse(row.messages),
      }
    } catch {
      return null
    }
  }

  async listSubagentTranscripts(
    sessionId: string,
  ): Promise<Array<{ agentId: string; agentType: string; description: string; createdAt: number }>> {
    const rows = this.db.prepare(
      'SELECT agent_id, agent_type, description, created_at FROM subagent_transcripts WHERE session_id = ? ORDER BY created_at DESC',
    ).all(sessionId) as Array<{ agent_id: string; agent_type: string; description: string; created_at: number }>
    return rows.map(r => ({
      agentId: r.agent_id,
      agentType: r.agent_type,
      description: r.description,
      createdAt: r.created_at,
    }))
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
