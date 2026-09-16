// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type HistoryKind = 'chat' | 'plan'

export interface HistorySearchResult {
  kind: HistoryKind
  id: string
  title: string
  snippet: string
  score: number
  seq?: number
  createdAt: number
  lastActivityAt: number
  status?: string
  overview?: string
}

export interface HistoryChat {
  id: string
  title: string
  summary?: string
  messages: Array<{ role: 'user' | 'assistant'; text: string; seq: number; createdAt: number }>
  createdAt: number
  lastActivityAt: number
}

export interface HistoryPlan {
  filename: string
  name: string
  overview: string
  status: string
  createdAt: string
  content: string
  updatedAt: number
}

type Session = {
  id: string
  messages?: any[]
  compactedSummary?: string | null
  totalMessages?: number
  createdAt?: number
  lastActivityAt?: number
  metadata?: Record<string, unknown>
}

const MAX_LIMIT = 50
const MAX_READ = 200

function textOf(message: any): string {
  const content = message?.content ?? message?.text
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function frontmatter(content: string): { name: string; overview: string; createdAt: string; status: string } {
  const raw = content.match(/^---\n([\s\S]*?)\n---/)?.[1] || ''
  const get = (key: string, fallback = '') =>
    raw.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, 'm'))?.[1]?.trim() || fallback
  return { name: get('name'), overview: get('overview'), createdAt: get('createdAt'), status: get('status', 'pending') }
}

function ftsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)
    .slice(0, 12)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(' OR ')
}

export class HistoryIndex {
  private readonly workspaceDir: string
  private readonly shogoDir: string
  private readonly indexPath: string
  private db: Database

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
    this.shogoDir = join(workspaceDir, '.shogo')
    this.indexPath = join(this.shogoDir, 'history-index.db')
    mkdirSync(this.shogoDir, { recursive: true })
    this.db = this.open()
  }

  private open(): Database {
    try {
      const db = new Database(this.indexPath)
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000')
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, string>
      if (Object.values(check)[0] !== 'ok') throw new Error('history index failed quick_check')
      this.schema(db)
      return db
    } catch {
      try { this.db?.close() } catch {}
      rmSync(this.indexPath, { force: true })
      rmSync(`${this.indexPath}-wal`, { force: true })
      rmSync(`${this.indexPath}-shm`, { force: true })
      const db = new Database(this.indexPath)
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000')
      this.schema(db)
      return db
    }
  }

  private schema(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS history_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        role TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT -1,
        created_at INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        overview TEXT,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_docs_ref ON history_docs(kind, ref_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
        kind UNINDEXED, ref_id UNINDEXED, title, role UNINDEXED, seq UNINDEXED, text,
        tokenize='porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS history_meta (
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        source_mtime INTEGER NOT NULL DEFAULT 0,
        indexed_seq INTEGER NOT NULL DEFAULT -1,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        overview TEXT,
        PRIMARY KEY(kind, ref_id)
      );
    `)
  }

  private deleteDocs(kind: HistoryKind, id: string, role?: string): void {
    const rows = this.db.prepare(
      `SELECT id FROM history_docs WHERE kind = ? AND ref_id = ?${role ? ' AND role = ?' : ''}`,
    ).all(...(role ? [kind, id, role] : [kind, id])) as Array<{ id: number }>
    const deleteFts = this.db.prepare('DELETE FROM history_fts WHERE rowid = ?')
    for (const row of rows) deleteFts.run(row.id)
    this.db.prepare(
      `DELETE FROM history_docs WHERE kind = ? AND ref_id = ?${role ? ' AND role = ?' : ''}`,
    ).run(...(role ? [kind, id, role] : [kind, id]))
  }

  private add(doc: {
    kind: HistoryKind; id: string; title: string; role: string; seq?: number
    createdAt: number; lastActivityAt: number; status?: string; overview?: string; text: string
  }): void {
    const result = this.db.prepare(`
      INSERT INTO history_docs
        (kind, ref_id, title, role, seq, created_at, last_activity_at, status, overview, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.kind, doc.id, doc.title, doc.role, doc.seq ?? -1, doc.createdAt,
      doc.lastActivityAt, doc.status ?? null, doc.overview ?? null, doc.text.slice(0, 128000),
    )
    this.db.prepare(`
      INSERT INTO history_fts(rowid, kind, ref_id, title, role, seq, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Number(result.lastInsertRowid), doc.kind, doc.id, doc.title, doc.role, doc.seq ?? -1, doc.text.slice(0, 128000))
  }

  private indexSession(row: { id: string; data: string; updated_at: number }): void {
    let session: Session
    try { session = JSON.parse(row.data) } catch { return }
    if (session.id !== row.id) return
    const messages = Array.isArray(session.messages) ? session.messages : []
    const total = Math.max(Number(session.totalMessages ?? messages.length), messages.length)
    const meta = this.db.prepare('SELECT * FROM history_meta WHERE kind = ? AND ref_id = ?').get('chat', row.id) as any
    const explicit = typeof session.metadata?.title === 'string' ? session.metadata.title.trim() : ''
    const firstUser = messages.find((message) => message?.role === 'user')
    const title = explicit || meta?.title || textOf(firstUser).slice(0, 100) || `Chat ${row.id.slice(0, 8)}`
    const createdAt = Number(session.createdAt ?? row.updated_at * 1000)
    const activity = Number(session.lastActivityAt ?? row.updated_at * 1000)
    const previousSeq = Number(meta?.indexed_seq ?? -1)
    if (meta?.title !== title) {
      this.db.prepare('UPDATE history_docs SET title = ? WHERE kind = ? AND ref_id = ?').run(title, 'chat', row.id)
    }

    if (session.compactedSummary) {
      this.deleteDocs('chat', row.id, 'summary')
      this.add({ kind: 'chat', id: row.id, title, role: 'summary', createdAt, lastActivityAt: activity, text: session.compactedSummary })
    } else if (!meta) {
      this.add({ kind: 'chat', id: row.id, title, role: 'summary', createdAt, lastActivityAt: activity, text: title })
    }
    const firstSeq = total - messages.length
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message?.role !== 'user' && message?.role !== 'assistant') continue
      const text = textOf(message)
      const seq = firstSeq + i
      if (!text || seq <= previousSeq) continue
      this.add({
        kind: 'chat', id: row.id, title, role: message.role, seq,
        createdAt: Number(message.timestamp ?? createdAt), lastActivityAt: activity, text,
      })
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO history_meta
        (kind, ref_id, source_mtime, indexed_seq, title, created_at, last_activity_at, status, overview)
      VALUES ('chat', ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(row.id, row.updated_at, Math.max(previousSeq, total - 1), title, createdAt, activity)
  }

  private indexPlan(filename: string, content: string, mtime: number): void {
    const existing = this.db.prepare('SELECT source_mtime FROM history_meta WHERE kind = ? AND ref_id = ?').get('plan', filename) as any
    if (existing?.source_mtime >= mtime) return
    const fm = frontmatter(content)
    const body = content.replace(/^---\n[\s\S]*?\n---\s*/, '').trim()
    const createdAt = Date.parse(fm.createdAt) || Math.floor(mtime * 1000)
    this.deleteDocs('plan', filename)
    this.add({
      kind: 'plan', id: filename, title: fm.name || filename, role: 'plan',
      createdAt, lastActivityAt: Math.floor(mtime * 1000), status: fm.status, overview: fm.overview,
      text: [fm.name, fm.overview, fm.status, body].filter(Boolean).join('\n'),
    })
    this.db.prepare(`
      INSERT OR REPLACE INTO history_meta
        (kind, ref_id, source_mtime, indexed_seq, title, created_at, last_activity_at, status, overview)
      VALUES ('plan', ?, ?, -1, ?, ?, ?, ?, ?)
    `).run(filename, mtime, fm.name || filename, createdAt, Math.floor(mtime * 1000), fm.status, fm.overview)
  }

  reindex(): void {
    try {
      const sessionPath = join(this.shogoDir, 'sessions.db')
      if (existsSync(sessionPath)) {
        const source = new Database(sessionPath, { readonly: true })
        try {
          const rows = source.prepare('SELECT id, data, updated_at FROM sessions').all() as Array<{ id: string; data: string; updated_at: number }>
          const present = new Set(rows.map((row) => row.id))
          const indexed = this.db.prepare('SELECT ref_id FROM history_meta WHERE kind = ?').all('chat') as Array<{ ref_id: string }>
          for (const row of indexed) {
            if (!present.has(row.ref_id)) {
              this.deleteDocs('chat', row.ref_id)
              this.db.prepare('DELETE FROM history_meta WHERE kind = ? AND ref_id = ?').run('chat', row.ref_id)
            }
          }
          for (const row of rows) this.indexSession(row)
        } finally { source.close() }
      }
      const plans = join(this.shogoDir, 'plans')
      const present = new Set<string>()
      if (existsSync(plans)) {
        for (const filename of readdirSync(plans)) {
          if (!filename.endsWith('.plan.md')) continue
          const path = join(plans, filename)
          if (!statSync(path).isFile()) continue
          present.add(filename)
          this.indexPlan(filename, readFileSync(path, 'utf8'), statSync(path).mtimeMs)
        }
      }
      const indexed = this.db.prepare('SELECT ref_id FROM history_meta WHERE kind = ?').all('plan') as Array<{ ref_id: string }>
      for (const row of indexed) {
        if (!present.has(row.ref_id)) {
          this.deleteDocs('plan', row.ref_id)
          this.db.prepare('DELETE FROM history_meta WHERE kind = ? AND ref_id = ?').run('plan', row.ref_id)
        }
      }
    } catch {
      try { this.db.close() } catch {}
      rmSync(this.indexPath, { force: true })
      this.db = this.open()
    }
  }

  search(query: string, options: { kind?: HistoryKind | 'all'; limit?: number; excludeRefId?: string } = {}): HistorySearchResult[] {
    this.reindex()
    const match = ftsQuery(query)
    const kind = options.kind && options.kind !== 'all' ? options.kind : null
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? 8)))
    if (!match) {
      const rows = this.db.prepare(`
        SELECT kind, ref_id, title, created_at, last_activity_at, status, overview
        FROM history_meta
        WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR ref_id != ?)
        ORDER BY last_activity_at DESC LIMIT ?
      `).all(kind, kind, options.excludeRefId ?? null, options.excludeRefId ?? null, limit) as any[]
      return rows.map((row) => ({
        kind: row.kind,
        id: row.ref_id,
        title: row.title,
        snippet: row.overview || row.title,
        score: 0.1,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        ...(row.status ? { status: row.status } : {}),
        ...(row.overview ? { overview: row.overview } : {}),
      }))
    }
    const rows = this.db.prepare(`
      SELECT f.kind, f.ref_id, f.title, f.seq, f.text, f.role,
             d.created_at, d.last_activity_at, d.status, d.overview,
             bm25(history_fts) AS rank,
             snippet(history_fts, 5, '[', ']', '…', 24) AS excerpt
      FROM history_fts f JOIN history_docs d ON d.id = f.rowid
      WHERE history_fts MATCH ?
        AND (? IS NULL OR f.kind = ?)
        AND (? IS NULL OR f.ref_id != ?)
      ORDER BY rank LIMIT ?
    `).all(match, kind, kind, options.excludeRefId ?? null, options.excludeRefId ?? null, limit * 8) as any[]
    const grouped = new Map<string, HistorySearchResult>()
    for (const row of rows) {
      const key = `${row.kind}:${row.ref_id}`
      const result: HistorySearchResult = {
        kind: row.kind, id: row.ref_id, title: row.title,
        snippet: row.excerpt || String(row.text).slice(0, 300),
        score: 1 / (1 + Math.abs(Number(row.rank))),
        ...(row.seq >= 0 ? { seq: row.seq } : {}),
        createdAt: row.created_at, lastActivityAt: row.last_activity_at,
        ...(row.status ? { status: row.status } : {}),
        ...(row.overview ? { overview: row.overview } : {}),
      }
      if (!grouped.has(key) || result.score > grouped.get(key)!.score) grouped.set(key, result)
    }
    return [...grouped.values()].sort((a, b) => b.score - a.score || b.lastActivityAt - a.lastActivityAt).slice(0, limit)
  }

  readChat(id: string, options: { fromSeq?: number; limit?: number } = {}): HistoryChat | null {
    this.reindex()
    const meta = this.db.prepare('SELECT * FROM history_meta WHERE kind = ? AND ref_id = ?').get('chat', id) as any
    if (!meta) return null
    const rows = this.db.prepare(`
      SELECT role, text, seq, created_at FROM history_docs
      WHERE kind = ? AND ref_id = ? AND role IN ('user', 'assistant') AND seq >= ?
      ORDER BY seq LIMIT ?
    `).all('chat', id, Math.max(0, options.fromSeq ?? 0), Math.min(MAX_READ, options.limit ?? 100)) as any[]
    const summary = this.db.prepare(
      'SELECT text FROM history_docs WHERE kind = ? AND ref_id = ? AND role = ? ORDER BY id DESC LIMIT 1',
    ).get('chat', id, 'summary') as { text: string } | null
    return {
      id, title: meta.title, ...(summary?.text ? { summary: summary.text } : {}),
      messages: rows.map((row) => ({ role: row.role, text: row.text, seq: row.seq, createdAt: row.created_at })),
      createdAt: meta.created_at, lastActivityAt: meta.last_activity_at,
    }
  }

  readPlan(filename: string): HistoryPlan | null {
    const path = join(this.shogoDir, 'plans', filename)
    if (!filename.endsWith('.plan.md') || !existsSync(path)) return null
    const content = readFileSync(path, 'utf8')
    const fm = frontmatter(content)
    return {
      filename, name: fm.name || filename, overview: fm.overview, status: fm.status,
      createdAt: fm.createdAt, content, updatedAt: statSync(path).mtimeMs,
    }
  }

  close(): void {
    try { this.db.close() } catch {}
  }
}
