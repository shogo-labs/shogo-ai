// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../session-manager'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'
import type { UserMessage, AssistantMessage } from '@mariozechner/pi-ai'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

describe('SqliteSessionPersistence', () => {
  let workDir: string
  let persistence: SqliteSessionPersistence

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-persist-test-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    persistence = new SqliteSessionPersistence(workDir)
  })

  afterEach(() => {
    persistence.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  test('save and load round-trip', async () => {
    const session = {
      id: 'test-1',
      messages: [user('hello'), assistant('hi')],
      compactedSummary: null,
      createdAt: 1000,
      lastActivityAt: 2000,
      totalMessages: 2,
      compactionCount: 0,
      metadata: {},
    }

    await persistence.save('test-1', session)
    const loaded = await persistence.load('test-1')

    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe('test-1')
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.totalMessages).toBe(2)
  })

  test('load returns null for missing session', async () => {
    const result = await persistence.load('nonexistent')
    expect(result).toBeNull()
  })

  test('delete removes the row', async () => {
    await persistence.save('to-delete', {
      id: 'to-delete',
      messages: [],
      compactedSummary: null,
      createdAt: 1000,
      lastActivityAt: 2000,
      totalMessages: 0,
      compactionCount: 0,
      metadata: {},
    })

    await persistence.delete('to-delete')
    const result = await persistence.load('to-delete')
    expect(result).toBeNull()
  })

  test('loadAll returns all persisted sessions', async () => {
    await persistence.save('s1', {
      id: 's1', messages: [], compactedSummary: null,
      createdAt: 1000, lastActivityAt: 2000, totalMessages: 0, compactionCount: 0, metadata: {},
    })
    await persistence.save('s2', {
      id: 's2', messages: [], compactedSummary: null,
      createdAt: 1000, lastActivityAt: 2000, totalMessages: 0, compactionCount: 0, metadata: {},
    })

    const all = await persistence.loadAll()
    expect(all).toHaveLength(2)
    expect(all.map((s) => s.id).sort()).toEqual(['s1', 's2'])
  })

  test('save overwrites existing session', async () => {
    await persistence.save('overwrite', {
      id: 'overwrite', messages: [user('v1')], compactedSummary: null,
      createdAt: 1000, lastActivityAt: 2000, totalMessages: 1, compactionCount: 0, metadata: {},
    })
    await persistence.save('overwrite', {
      id: 'overwrite', messages: [user('v1'), user('v2')], compactedSummary: null,
      createdAt: 1000, lastActivityAt: 3000, totalMessages: 2, compactionCount: 0, metadata: {},
    })

    const loaded = await persistence.load('overwrite')
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.totalMessages).toBe(2)

    const all = await persistence.loadAll()
    expect(all).toHaveLength(1)
  })

  test('survives close and reopen', async () => {
    await persistence.save('durable', {
      id: 'durable', messages: [user('persist me')], compactedSummary: null,
      createdAt: 1000, lastActivityAt: 2000, totalMessages: 1, compactionCount: 0, metadata: {},
    })

    persistence.close()

    const reopened = new SqliteSessionPersistence(workDir)
    try {
      const loaded = await reopened.load('durable')
      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe('durable')
      expect(loaded!.messages).toHaveLength(1)
    } finally {
      reopened.close()
    }
  })
})

describe('SessionManager with SQLite persistence', () => {
  let workDir: string
  let sm: SessionManager
  let persistence: SqliteSessionPersistence

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-sm-persist-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
    persistence = new SqliteSessionPersistence(workDir)
    sm = new SessionManager({ sessionTtlSeconds: 60, maxMessages: 30, pruning: false })
    sm.setPersistence(persistence)
  })

  afterEach(() => {
    sm.destroy()
    persistence.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  test('addMessages persists to disk', async () => {
    sm.addMessages('s1', user('hello'))
    await new Promise((r) => setTimeout(r, 50))

    const loaded = await persistence.load('s1')
    expect(loaded).not.toBeNull()
    expect(loaded!.messages).toHaveLength(1)
  })

  test('restoreSessions loads from disk', async () => {
    await persistence.save('restored', {
      id: 'restored',
      messages: [user('from disk')],
      compactedSummary: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      totalMessages: 1,
      compactionCount: 0,
      metadata: {},
    })

    const count = await sm.restoreSessions()
    expect(count).toBe(1)

    const session = sm.get('restored')
    expect(session).not.toBeUndefined()
    expect(session!.messages).toHaveLength(1)
  })

  test('getOrCreateAsync loads from disk before creating', async () => {
    await persistence.save('async-load', {
      id: 'async-load',
      messages: [user('persisted')],
      compactedSummary: 'previous summary',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      totalMessages: 5,
      compactionCount: 1,
      metadata: { tag: 'test' },
    })

    const session = await sm.getOrCreateAsync('async-load')
    expect(session.id).toBe('async-load')
    expect(session.messages).toHaveLength(1)
    expect(session.compactedSummary).toBe('previous summary')
    expect(session.totalMessages).toBe(5)
  })

  test('compact persists the compacted state', async () => {
    sm = new SessionManager({ maxMessages: 4, keepRecentMessages: 2, pruning: false })
    sm.setPersistence(persistence)

    for (let i = 0; i < 5; i++) {
      sm.addMessages('compact-test', user(`msg ${i}`))
    }
    await sm.compact('compact-test')

    await new Promise((r) => setTimeout(r, 50))
    const loaded = await persistence.load('compact-test')
    expect(loaded).not.toBeNull()
    expect(loaded!.compactedSummary).not.toBeNull()
    expect(loaded!.messages.length).toBe(2)
  })
})

describe('SqliteSessionPersistence — subagent transcripts', () => {
  let workDir: string
  let persistence: SqliteSessionPersistence

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-subagent-test-${Date.now()}-${Math.random()}`)
    mkdirSync(workDir, { recursive: true })
    persistence = new SqliteSessionPersistence(workDir)
  })

  afterEach(() => {
    persistence.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  test('saveSubagentTranscript + loadSubagentTranscript round-trip', async () => {
    const messages = [user('do something'), assistant('done')]
    await persistence.saveSubagentTranscript('agent-1', 'sess-1', 'general-purpose', 'Test agent', messages)
    const loaded = await persistence.loadSubagentTranscript('agent-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.agentType).toBe('general-purpose')
    expect(loaded!.description).toBe('Test agent')
    expect(loaded!.messages).toHaveLength(2)
  })

  test('loadSubagentTranscript returns null for unknown agent', async () => {
    const loaded = await persistence.loadSubagentTranscript('unknown-agent-id')
    expect(loaded).toBeNull()
  })

  test('loadSubagentTranscript returns null on corrupt JSON', async () => {
    const db = persistence.getDb()
    db.prepare(
      `INSERT INTO subagent_transcripts (agent_id, session_id, agent_type, description, messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('corrupt-agent', 'sess', 'general', 'desc', '{not-json', 0, 0)
    const loaded = await persistence.loadSubagentTranscript('corrupt-agent')
    expect(loaded).toBeNull()
  })

  test('saveSubagentTranscript overwrites previous row (INSERT OR REPLACE)', async () => {
    await persistence.saveSubagentTranscript('agent-2', 'sess', 'gp', 'first', [user('a')])
    await persistence.saveSubagentTranscript('agent-2', 'sess', 'gp', 'second', [user('a'), user('b')])
    const loaded = await persistence.loadSubagentTranscript('agent-2')
    expect(loaded!.description).toBe('second')
    expect(loaded!.messages).toHaveLength(2)
  })

  test('listSubagentTranscripts returns rows for the session, ordered DESC by createdAt', async () => {
    await persistence.saveSubagentTranscript('a1', 'list-sess', 'gp', 'first', [user('1')])
    await new Promise((r) => setTimeout(r, 1100)) // ensure created_at differs (seconds resolution)
    await persistence.saveSubagentTranscript('a2', 'list-sess', 'gp', 'second', [user('2')])
    await persistence.saveSubagentTranscript('a3', 'other-sess', 'gp', 'other', [user('3')])

    const items = await persistence.listSubagentTranscripts('list-sess')
    expect(items).toHaveLength(2)
    expect(items[0].agentId).toBe('a2')
    expect(items[0].agentType).toBe('gp')
    expect(items[0].description).toBe('second')
    expect(items[1].agentId).toBe('a1')
    expect(typeof items[0].createdAt).toBe('number')
  })

  test('listSubagentTranscripts returns [] for unknown session', async () => {
    expect(await persistence.listSubagentTranscripts('no-such-session')).toEqual([])
  })
})

describe('SqliteSessionPersistence — agent registry', () => {
  let workDir: string
  let persistence: SqliteSessionPersistence

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-registry-test-${Date.now()}-${Math.random()}`)
    mkdirSync(workDir, { recursive: true })
    persistence = new SqliteSessionPersistence(workDir)
  })

  afterEach(() => {
    persistence.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  test('saveAgentType + loadAgentTypes round-trip', () => {
    persistence.saveAgentType('my-agent', { foo: 'bar', n: 42 }, { runs: 0 })
    const all = persistence.loadAgentTypes()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('my-agent')
    expect(all[0].config).toEqual({ foo: 'bar', n: 42 })
    expect(all[0].metrics).toEqual({ runs: 0 })
  })

  test('saveAgentType preserves created_at on replace (COALESCE branch)', () => {
    persistence.saveAgentType('persist-ctime', { v: 1 }, { runs: 1 })
    const db = persistence.getDb()
    const before = db.prepare('SELECT created_at FROM agent_registry WHERE name = ?').get('persist-ctime') as { created_at: number }
    // Force a delay so updated_at can advance but created_at must be preserved.
    persistence.saveAgentType('persist-ctime', { v: 2 }, { runs: 2 })
    const after = db.prepare('SELECT created_at, updated_at FROM agent_registry WHERE name = ?').get('persist-ctime') as { created_at: number; updated_at: number }
    expect(after.created_at).toBe(before.created_at)
    const reloaded = persistence.loadAgentTypes().find((a) => a.name === 'persist-ctime')!
    expect(reloaded.config).toEqual({ v: 2 })
  })

  test('deleteAgentType returns true when a row is removed, false otherwise', () => {
    persistence.saveAgentType('to-delete', { a: 1 }, { b: 2 })
    expect(persistence.deleteAgentType('to-delete')).toBe(true)
    expect(persistence.deleteAgentType('to-delete')).toBe(false)
    expect(persistence.deleteAgentType('never-existed')).toBe(false)
  })

  test('loadAgentTypes skips rows whose JSON is corrupt', () => {
    const db = persistence.getDb()
    db.prepare(
      'INSERT INTO agent_registry (name, config, metrics, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('good', JSON.stringify({ ok: true }), JSON.stringify({}), 0, 0)
    db.prepare(
      'INSERT INTO agent_registry (name, config, metrics, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('corrupt', '{bad json', '{also bad', 0, 0)
    const all = persistence.loadAgentTypes()
    expect(all.find((a) => a.name === 'good')).toBeDefined()
    expect(all.find((a) => a.name === 'corrupt')).toBeUndefined()
  })

  test('updateAgentMetrics updates only metrics column', () => {
    persistence.saveAgentType('upd', { stable: 'config' }, { runs: 0 })
    persistence.updateAgentMetrics('upd', { runs: 7, lastError: null })
    const all = persistence.loadAgentTypes()
    const row = all.find((a) => a.name === 'upd')!
    expect(row.config).toEqual({ stable: 'config' })
    expect(row.metrics).toEqual({ runs: 7, lastError: null })
  })

  test('updateAgentMetrics on a non-existent name is a silent no-op', () => {
    expect(() => persistence.updateAgentMetrics('no-such-agent', { runs: 1 })).not.toThrow()
    expect(persistence.loadAgentTypes().find((a) => a.name === 'no-such-agent')).toBeUndefined()
  })
})
