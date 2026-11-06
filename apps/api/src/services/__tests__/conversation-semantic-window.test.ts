// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-347: the search indexer reads a `createdAt` window per tick, and a
 * message whose embedding insert keeps failing is retried at most once an hour
 * instead of on every tick (each retry costs an embedding call).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const MINUTE = 60_000
const FAST_WINDOW_MS = 30 * MINUTE

const state = {
  rows: [] as Array<{ id: string; workspaceId: string; text: string; createdAt: Date; attachments: any[] }>,
  lastWhere: null as any,
  storeAttempts: 0,
  embedCalls: 0,
  failStore: false,
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    conversationMessage: {
      findMany: async (args: any) => {
        state.lastWhere = args.where
        const gte = args.where?.createdAt?.gte?.getTime() ?? -Infinity
        return state.rows.filter((r) => r.createdAt.getTime() >= gte).slice(0, args.take ?? 64)
      },
    },
    conversationMessageEmbedding: {
      create: async () => {
        state.storeAttempts++
        if (state.failStore) throw new Error('value too long for type vector(1536)')
        return {}
      },
    },
  },
}))
const realRegion = await import('../../lib/region')
mock.module('../../lib/region', () => ({ ...realRegion, homeRegionWorkspaceWhere: () => null }))
mock.module('../../lib/hosted-workspace', () => ({ notHostedWorkspaceWhere: async () => ({}) }))
mock.module('../conversation.service', () => ({
  MESSAGE_INCLUDE: {},
  serializeMessage: (m: unknown) => m,
  ConversationError: class ConversationError extends Error {},
}))
mock.module('../conversation-agent-dispatcher', () => ({
  loadMentionNames: async () => ({}),
  runWorkspaceAgentPrompt: async () => {},
}))
mock.module('../conversation-mentions', () => ({ renderMentionsAsText: (text: string) => text }))
mock.module('../conversation-search', () => ({ searchMessages: async () => [] }))

const { indexPendingMessages, _setEmbeddingProviderForTests, _resetEmbeddingFailuresForTests } = await import(
  '../conversation-semantic'
)

/** The backoff is about the store failing, not the window, so give it room. */
const WIDE_WINDOW_MS = 90 * 24 * 60 * MINUTE

const warnings: string[] = []
const realWarn = console.warn
const NOW = new Date(Date.UTC(2026, 10, 5, 12, 0, 0))

beforeEach(() => {
  process.env.SHOGO_LOCAL_MODE = 'true'
  state.rows = []
  state.lastWhere = null
  state.storeAttempts = 0
  state.embedCalls = 0
  state.failStore = false
  warnings.length = 0
  _resetEmbeddingFailuresForTests()
  _setEmbeddingProviderForTests({
    model: 'toy',
    embed: async (texts: string[]) => {
      state.embedCalls++
      return texts.map(() => [0.5, 0.5])
    },
  })
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '))
  }
})

afterEach(() => {
  console.warn = realWarn
  _setEmbeddingProviderForTests(undefined)
  delete process.env.SHOGO_LOCAL_MODE
})

const row = (id: string, ageMs: number, text = `message ${id}`) => ({
  id,
  workspaceId: 'ws-1',
  text,
  createdAt: new Date(NOW.getTime() - ageMs),
  attachments: [],
})

describe('indexPendingMessages window', () => {
  it('reads only the window it is given, so the fast pass is a createdAt range scan', async () => {
    state.rows = [row('fresh', 60_000), row('stale', 2 * 60 * MINUTE)]
    expect(await indexPendingMessages(NOW, 64, FAST_WINDOW_MS)).toBe(1)
    expect(state.lastWhere.createdAt.gte.getTime()).toBe(NOW.getTime() - FAST_WINDOW_MS)
    expect(state.embedCalls).toBe(1)
  })
})

describe('the hourly full pass', () => {
  it('still sees what the fast window cannot', async () => {
    // (a) an old message whose embedding an edit deleted, and (b) an agent
    // reply that only finished long after `createdAt`, are both older than the
    // fast window but inside the 90-day one.
    state.rows = [row('edited-old', 2 * 60 * MINUTE), row('long-run', 45 * MINUTE)]
    expect(await indexPendingMessages(NOW, 64, FAST_WINDOW_MS)).toBe(0)
    expect(await indexPendingMessages(NOW, 64, WIDE_WINDOW_MS)).toBe(2)
  })
})

describe('a message whose embedding will not store', () => {
  it('is logged with its id, and is not retried until the hour is up', async () => {
    state.failStore = true
    state.rows = [row('poison', 60_000)]

    expect(await indexPendingMessages(NOW, 64, WIDE_WINDOW_MS)).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('poison')
    expect(state.storeAttempts).toBe(1)
    expect(state.embedCalls).toBe(1)

    // Same minute, and again nine minutes later: skipped, no second embed call.
    expect(await indexPendingMessages(new Date(NOW.getTime() + MINUTE), 64, WIDE_WINDOW_MS)).toBe(0)
    expect(await indexPendingMessages(new Date(NOW.getTime() + 10 * MINUTE), 64, WIDE_WINDOW_MS)).toBe(0)
    expect(state.storeAttempts).toBe(1)
    expect(state.embedCalls).toBe(1)
    expect(warnings).toHaveLength(1)

    // An hour later it is worth one more try (the row is still pending).
    expect(await indexPendingMessages(new Date(NOW.getTime() + 61 * MINUTE), 64, WIDE_WINDOW_MS)).toBe(0)
    expect(state.storeAttempts).toBe(2)

    // And once the underlying problem is fixed it indexes normally.
    state.failStore = false
    expect(await indexPendingMessages(new Date(NOW.getTime() + 122 * MINUTE), 64, WIDE_WINDOW_MS)).toBe(1)
    expect(state.storeAttempts).toBe(3)
  })
})
