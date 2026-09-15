import { describe, expect, test, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryIndex } from '../history-index'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shogo-history-'))
  roots.push(root)
  mkdirSync(join(root, '.shogo', 'plans'), { recursive: true })
  const db = new Database(join(root, '.shogo', 'sessions.db'))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  db.close()
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('HistoryIndex', () => {
  test('indexes and groups chat messages and plans', () => {
    const root = fixture()
    const sessions = new Database(join(root, '.shogo', 'sessions.db'))
    sessions.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
      'chat-1',
      JSON.stringify({
        id: 'chat-1',
        createdAt: 1000,
        lastActivityAt: 2000,
        messages: [
          { role: 'user', content: 'We decided to use SQLite for history.' },
          { role: 'assistant', content: 'The search index will be local.' },
        ],
      }),
      2,
    )
    sessions.close()
    writeFileSync(join(root, '.shogo/plans/search.plan.md'), [
      '---',
      'name: History Search',
      'overview: Search chats and plans',
      'status: active',
      'createdAt: 2026-09-15T10:00:00Z',
      '---',
      '# SQLite',
      'Use FTS5 for fast search.',
    ].join('\n'))

    const index = new HistoryIndex(root)
    expect(index.search('SQLite')).toHaveLength(2)
    expect(index.search('', { kind: 'plan' })[0]).toMatchObject({ id: 'search.plan.md', kind: 'plan' })
    expect(index.readChat('chat-1')?.messages).toHaveLength(2)
    expect(index.readPlan('search.plan.md')?.name).toBe('History Search')
    index.close()
  })

  test('rebuilds a corrupt derived index from source data', () => {
    const root = fixture()
    writeFileSync(join(root, '.shogo/plans/rebuild.plan.md'), '---\nname: Rebuild\n---\n# Rebuild me')
    const first = new HistoryIndex(root)
    first.close()
    writeFileSync(join(root, '.shogo/history-index.db'), 'not a sqlite database')
    const rebuilt = new HistoryIndex(root)
    expect(rebuilt.search('Rebuild')[0]?.title).toBe('Rebuild')
    rebuilt.close()
  })

  test('retains appended messages and refreshes compaction summary', () => {
    const root = fixture()
    const sessionsPath = join(root, '.shogo', 'sessions.db')
    const sessions = new Database(sessionsPath)
    sessions.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
      'chat-1',
      JSON.stringify({
        id: 'chat-1',
        totalMessages: 1,
        compactedSummary: 'Original summary',
        messages: [{ role: 'user', content: 'First message' }],
      }),
      1,
    )
    sessions.close()
    const index = new HistoryIndex(root)
    expect(index.readChat('chat-1')?.messages[0].text).toBe('First message')

    const next = new Database(sessionsPath)
    next.prepare('UPDATE sessions SET data = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({
        id: 'chat-1',
        totalMessages: 2,
        compactedSummary: 'Updated summary after compaction',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'Second message' },
        ],
      }),
      2,
      'chat-1',
    )
    next.close()
    expect(index.search('Second message')).toHaveLength(1)
    expect(index.readChat('chat-1')?.summary).toContain('Updated summary')
    index.close()
  })
})
