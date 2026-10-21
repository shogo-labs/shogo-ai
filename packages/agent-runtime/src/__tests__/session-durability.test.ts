// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A conversation never loses its messages (SHO-137).
 *
 * The idle pruner used to delete the *persisted* session after
 * `sessionTtlSeconds` (an hour by default), so a chat that ran overnight was
 * gone from `.shogo/sessions.db` by morning and the next background-task wake
 * reached the model as a single wake note. These tests pin the invariant: an
 * idle sweep evicts memory only, a cold pod reads the conversation back from
 * disk, and a message-less session is the only thing reclamation removes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../session-manager'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'
import { parseHistorySeed } from '../history-seed'
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai'

const CANARY = 'canary-overnight-context-9f3c'

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

function makeManager(workDir: string, overrides: Record<string, unknown> = {}) {
  const persistence = new SqliteSessionPersistence(workDir)
  const sm = new SessionManager({
    sessionTtlSeconds: 1,
    maxMessages: 30,
    maxEstimatedTokens: 100_000,
    keepRecentMessages: 10,
    pruneIntervalSeconds: 999,
    contextWindowTokens: 200_000,
    ...overrides,
  })
  sm.setPersistence(persistence)
  return { sm, persistence }
}

/** A different SessionManager over the same files: the cold pod. */
function freshManager(workDir: string) {
  return makeManager(workDir)
}

describe('a conversation survives idle time', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-durability-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('AC1 — the idle sweep evicts memory but keeps the persisted history', async () => {
    const { sm, persistence } = makeManager(workDir)
    sm.addMessages('chat-1', user(`first: ${CANARY}`), assistant('noted'))

    // Pretend the session went quiet well past its TTL.
    sm.get('chat-1')!.lastActivityAt = Date.now() - 10 * 60_000
    const pruned = sm.pruneExpired()

    expect(pruned).toEqual(['chat-1'])
    expect(sm.get('chat-1')).toBeUndefined()

    const stored = await persistence.load('chat-1')
    expect(stored).not.toBeNull()
    expect(stored!.messages).toHaveLength(2)
    expect(JSON.stringify(stored!.messages)).toContain(CANARY)
    persistence.close()
  })

  test('AC2 — a cold pod reads the thread back instead of starting empty', async () => {
    const first = makeManager(workDir)
    first.sm.addMessages('chat-1', user(`first: ${CANARY}`), assistant('ack'))
    first.persistence.close()

    const cold = freshManager(workDir)
    const session = await cold.sm.getOrCreateAsync('chat-1')

    expect(session.messages).toHaveLength(2)
    const history = cold.sm.buildHistory('chat-1')
    expect(JSON.stringify(history)).toContain(CANARY)
    cold.persistence.close()
  })

  test('AC6 — a cold miss loads, and never fabricates an empty session over one on disk', async () => {
    const first = makeManager(workDir)
    first.sm.addMessages('chat-1', user(`first: ${CANARY}`))
    first.persistence.close()

    const cold = freshManager(workDir)
    // `loadSession` is the read-only half: nothing on disk means null, not a
    // new session the next persist could write over a good copy.
    expect(await cold.sm.loadSession('chat-1')).not.toBeNull()
    expect(await cold.sm.loadSession('never-existed')).toBeNull()
    expect(cold.sm.get('never-existed')).toBeUndefined()

    // …and the chat turn path's entry point (getOrCreateAsync) hydrates first.
    const restored = await cold.sm.getOrCreateAsync('chat-1')
    expect(restored.messages).toHaveLength(1)
    cold.persistence.close()
  })

  test('an explicit delete still wipes memory and disk', async () => {
    const { sm, persistence } = makeManager(workDir)
    sm.addMessages('chat-1', user(`first: ${CANARY}`))

    expect(await sm.deleteSession('chat-1')).toBe(true)
    expect(sm.get('chat-1')).toBeUndefined()
    expect(await persistence.load('chat-1')).toBeNull()
    persistence.close()
  })

  test('reclamation only removes sessions that never held a message', async () => {
    const { sm, persistence } = makeManager(workDir, { emptySessionRetentionDays: 30 })
    sm.addMessages('with-messages', user(`first: ${CANARY}`))

    const longAgo = Date.now() - 60 * 24 * 60 * 60 * 1000
    const empty = {
      id: 'empty-session',
      messages: [],
      compactedSummary: null,
      createdAt: longAgo,
      lastActivityAt: longAgo,
      totalMessages: 0,
      compactionCount: 0,
      metadata: {},
    }
    await persistence.save('empty-session', empty)
    await persistence.save('with-messages', { ...(await persistence.load('with-messages'))!, lastActivityAt: longAgo })
    // `updated_at` is the store's own "last touched" stamp — the indexed column
    // the sweep filters on — so age both rows the way a quiet month would.
    const age = Math.floor(longAgo / 1000)
    persistence.getDb().prepare('UPDATE sessions SET updated_at = ?').run(age)

    const reclaimed = await sm.reclaimEmptySessions()

    expect(reclaimed).toEqual(['empty-session'])
    expect(await persistence.load('empty-session')).toBeNull()
    expect((await persistence.load('with-messages'))!.messages).toHaveLength(1)
    persistence.close()
  })

  test('a durable summary installed from the API is prepended to the rebuilt history', async () => {
    const { sm, persistence } = makeManager(workDir)
    sm.setCompactedSummary('chat-1', 'Earlier: the team agreed the deploy moves to Thursday.')
    sm.addMessages('chat-1', user('and the rollback plan?'))

    const history = JSON.stringify(sm.buildHistory('chat-1'))
    expect(history).toContain('deploy moves to Thursday')
    expect(history).toContain('rollback plan')
    persistence.close()
  })

  test('a longer compaction summary is never replaced by a shorter durable one', () => {
    const { sm, persistence } = makeManager(workDir)
    const session = sm.getOrCreate('chat-1')
    session.compactedSummary = 'Detailed fold: a much longer account of the conversation.'
    sm.setCompactedSummary('chat-1', 'short')
    expect(session.compactedSummary).toContain('much longer account')
    persistence.close()
  })
})

describe('historySeed parsing', () => {
  test('keeps roles, drops junk, and needs something usable', () => {
    const seed = parseHistorySeed({
      summary: '  Earlier: we shipped the parser.  ',
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'system', text: 'ignored' },
        { role: 'assistant', text: 'hi' },
        { role: 'user', text: '   ' },
        null,
      ],
    })
    expect(seed).not.toBeNull()
    expect(seed!.summary).toBe('Earlier: we shipped the parser.')
    expect(seed!.messages).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ])
  })

  test('keeps the NEWEST messages when a seed is over the char cap', () => {
    // Ten 20k rows against a 120k cap: the tail must survive, because the
    // messages closest to the turn are the ones that explain it.
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `MSG${i} ${'x'.repeat(20_000)}`,
    }))
    const seed = parseHistorySeed({ messages })
    expect(seed).not.toBeNull()
    const kept = seed!.messages.map((m) => m.text.slice(0, 4))
    expect(kept).toEqual(['MSG5', 'MSG6', 'MSG7', 'MSG8', 'MSG9'])
    // Still oldest-first, so the runtime seeds them in order.
    expect(seed!.messages[seed!.messages.length - 1].text.startsWith('MSG9')).toBe(true)
  })

  test('is null for absent or empty input, so the turn is unaffected', () => {
    expect(parseHistorySeed(undefined)).toBeNull()
    expect(parseHistorySeed({})).toBeNull()
    expect(parseHistorySeed({ messages: [] })).toBeNull()
    expect(parseHistorySeed('nope')).toBeNull()
  })
})

describe('the guarantee cannot be undone by one careless call', () => {
  const read = (rel: string) => require('fs').readFileSync(join(import.meta.dir, rel), 'utf8') as string

  function functionBody(source: string, signature: string): string {
    const start = source.indexOf(signature)
    expect(start).toBeGreaterThan(-1)
    // Crude but enough: from the signature to the next top-level member.
    const rest = source.slice(start + signature.length)
    const end = rest.search(/\n  \/\*\*|\n  [a-zA-Z#*]+\(|\n}\n/)
    return rest.slice(0, end === -1 ? rest.length : end)
  }

  test('the idle sweep never deletes a persisted session', () => {
    const source = read('../session-manager.ts')
    const body = functionBody(source, 'pruneExpired(): string[] {')
    expect(body).not.toContain('persistence')
    expect(body).not.toContain('deleteSession')
    expect(body).toContain('this.sessions.delete(id)')
  })

  test('the chat route loads a stored session instead of creating an empty one', () => {
    const source = read('../server.ts')
    expect(source).toContain('await sessionManager.getOrCreateAsync(chatSessionKey)')
    expect(source).not.toContain('sessionManager.getOrCreate(chatSessionKey)')
    // …and a one-message turn still seeds from `historySeed`.
    expect(source).toContain('parseHistorySeed(body.historySeed)')
  })

  test('the gateway turn start hydrates before it touches the session', () => {
    const source = read('../gateway.ts')
    const body = functionBody(source, 'async processChatMessageStream(')
    expect(body).toContain('await this.sessionManager.getOrCreateAsync(sessionId)')
  })
})
