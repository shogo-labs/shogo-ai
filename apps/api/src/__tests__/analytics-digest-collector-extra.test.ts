// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/analytics-digest-collector.ts — targets:
 *
 *  - `chunkConversations` splitting behavior when a single thread
 *    exceeds the MAX_TOKENS_PER_CHUNK boundary (boundary push +
 *    MAX_CHUNKS cap).
 *  - AI-analysis paths inside `generateDigest` (routed through the shared
 *    multi-provider `resolveLanguageModel` + `ai` `generateText` seams):
 *      • happy-path JSON parse
 *      • model throwing (returns `AI analysis error: <msg>`).
 *      • no transport configured skips the call entirely.
 *  - `generateDigest` with empty conversations — chunksProcessed=0,
 *    aiInsights=null, upsert still runs.
 *  - `startAnalyticsDigestCollector` schedules a setTimeout (verified
 *    by stubbing globalThis.setTimeout) and `stopAnalyticsDigestCollector`
 *    clears it.
 *
 *   bun test apps/api/src/__tests__/analytics-digest-collector-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

const fixtures = {
  funnel: { signups: 0, onboarded: 0, createdProject: 0, sentMessage: 0, engaged: 0, avgMinToFirstProject: 0, avgMinToFirstMessage: 0 },
  activity: { total: 0, users: [] as any[] },
  templates: { templates: [] },
  sources: { sources: [] },
  conversations: { conversations: [] as any[] },
}

mock.module('../services/analytics.service', () => ({
  getUserFunnel: async () => fixtures.funnel,
  getUserActivityTable: async () => fixtures.activity,
  getTemplateEngagement: async () => fixtures.templates,
  getSourceBreakdown: async () => fixtures.sources,
  getChatConversations: async () => fixtures.conversations,
}))

// The collector resolves the basic default through the shared multi-provider
// resolver and runs it via `ai` `generateText`. Both are mocked here so the
// AI-analysis branches can be driven deterministically without a real provider.
const aiState: { text?: string; throws?: boolean; throwMsg?: string; resolverReturnsNull?: boolean } = {}
mock.module('@shogo/model-catalog', () => ({
  getMaxOutputTokens: (_: string) => 4096,
  resolveAgentModeDefault: (mode: string) => (mode === 'basic' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6'),
}))
mock.module('../lib/resolve-language-model', () => ({
  resolveLanguageModel: (id: string) =>
    aiState.resolverReturnsNull ? null : { model: { __id: id }, billingModelId: id, provider: 'custom' },
}))
mock.module('ai', () => ({
  generateText: async () => {
    if (aiState.throws) throw new Error(aiState.throwMsg ?? 'boom')
    return {
      text:
        aiState.text ??
        JSON.stringify({ takeaways: ['x'], intents: [], painPoints: [], securityFlags: [] }),
    }
  },
}))

const {
  chunkConversations,
  mergeAnalyses,
  generateDigest,
  startAnalyticsDigestCollector,
  stopAnalyticsDigestCollector,
} = await import('../lib/analytics-digest-collector')

beforeEach(() => {
  fixtures.conversations = { conversations: [] }
  fixtures.activity = { total: 0, users: [] }
  aiState.text = undefined
  aiState.throws = false
  aiState.throwMsg = undefined
  aiState.resolverReturnsNull = false
})
afterEach(() => {
  stopAnalyticsDigestCollector?.()
})

// ─── chunkConversations boundary behavior ────────────────────────────────

describe('chunkConversations — boundary behavior', () => {
  test('splits when serialized thread exceeds the per-chunk token budget', () => {
    // ~400 000 chars ≈ ~100 000 tokens at CHARS_PER_TOKEN=4 — a single
    // thread bigger than that flushes the buffer.
    const huge = 'x'.repeat(450_000)
    const thread = (i: number) => ({
      userName: `u${i}`,
      projectName: `p${i}`,
      messages: [{ role: 'user', content: huge }],
    })
    const chunks = chunkConversations([thread(1), thread(2), thread(3)] as any)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.length).toBeLessThanOrEqual(3)
  })

  test('caps at MAX_CHUNKS (3) even when 5 oversized threads are passed', () => {
    const huge = 'x'.repeat(450_000)
    const threads = Array.from({ length: 5 }, (_, i) => ({
      userName: `u${i}`,
      projectName: `p${i}`,
      messages: [{ role: 'user', content: huge }],
    }))
    const chunks = chunkConversations(threads as any)
    expect(chunks.length).toBeLessThanOrEqual(3)
  })

  test('empty thread list produces zero chunks', () => {
    expect(chunkConversations([])).toEqual([])
  })

  test('thread with no templateId omits the "(template: ...)" suffix', () => {
    const chunks = chunkConversations([
      { userName: 'Ada', projectName: 'X', messages: [{ role: 'user', content: 'hi' }] },
    ] as any)
    expect(chunks[0]).toContain('[Ada / X]')
    expect(chunks[0]).not.toContain('template:')
  })
})

// ─── mergeAnalyses edge cases ────────────────────────────────────────────

describe('mergeAnalyses — edge cases', () => {
  test('caps takeaways at 5 across all chunks', () => {
    const merged = mergeAnalyses([
      { takeaways: ['a', 'b', 'c'], intents: [], painPoints: [], securityFlags: [] },
      { takeaways: ['d', 'e', 'f'], intents: [], painPoints: [], securityFlags: [] },
      { takeaways: ['g', 'h'], intents: [], painPoints: [], securityFlags: [] },
    ])
    expect(merged.takeaways).toHaveLength(5)
  })

  test('caps intent.examples at 3 per category', () => {
    const merged = mergeAnalyses([
      {
        takeaways: [],
        intents: [{ category: 'crm', count: 1, examples: ['a', 'b', 'c', 'd', 'e'] }],
        painPoints: [],
        securityFlags: [],
      },
    ])
    expect(merged.intents[0].examples).toHaveLength(3)
  })

  test('empty input produces empty merged shape', () => {
    expect(mergeAnalyses([])).toEqual({ takeaways: [], intents: [], painPoints: [], securityFlags: [] })
  })
})

// ─── AI-analysis paths (via generateDigest) ──────────────────────────────

describe('generateDigest — AI analysis paths', () => {
  function setOneConversation() {
    fixtures.conversations = {
      conversations: [{
        userName: 'Ada',
        projectName: 'Planner',
        messages: [
          { role: 'user', content: 'build planner' },
          { role: 'assistant', content: 'ok' },
        ],
      }],
    }
  }

  test('happy path: parses JSON returned by the model', async () => {
    setOneConversation()
    aiState.text = JSON.stringify({ takeaways: ['x'], intents: [], painPoints: [], securityFlags: [] })

    const upsert = mock(async (args: any) => ({ id: 'd1', ...args.create }))
    const digest = await generateDigest({ analyticsDigest: { upsert } } as any)

    expect(digest.id).toBe('d1')
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0][0].create.aiInsights.takeaways).toEqual(['x'])
  })

  test('model throwing → synthetic "AI analysis error: <msg>" takeaway', async () => {
    setOneConversation()
    aiState.throws = true
    aiState.throwMsg = 'upstream 429'

    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    const upsert = mock(async (args: any) => ({ id: 'd2', ...args.create }))
    await generateDigest({ analyticsDigest: { upsert } } as any)
    errSpy.mockRestore()

    const insights = upsert.mock.calls[0][0].create.aiInsights
    expect(insights.takeaways[0]).toBe('AI analysis error: upstream 429')
  })

  test('no transport configured → "AI analysis skipped: no model transport"', async () => {
    setOneConversation()
    aiState.resolverReturnsNull = true
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const upsert = mock(async (args: any) => ({ id: 'd4', ...args.create }))
    await generateDigest({ analyticsDigest: { upsert } } as any)
    warnSpy.mockRestore()

    const insights = upsert.mock.calls[0][0].create.aiInsights
    expect(insights.takeaways[0]).toBe('AI analysis skipped: no model transport')
  })

  test('empty conversations → no model call, aiInsights stays null, upsert still runs', async () => {
    fixtures.conversations = { conversations: [] }

    const upsert = mock(async (args: any) => ({ id: 'd-empty', ...args.create }))
    await generateDigest({ analyticsDigest: { upsert } } as any)

    expect(upsert.mock.calls[0][0].create.aiInsights).toBeNull()
    expect(upsert.mock.calls[0][0].create.chunksProcessed).toBe(0)
    expect(upsert.mock.calls[0][0].create.messagesAnalyzed).toBe(0)
  })
})

// ─── scheduler ──────────────────────────────────────────────────────────

describe('start/stopAnalyticsDigestCollector', () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  })

  test('start schedules a setTimeout for the next UTC digest hour', () => {
    let scheduledDelay = -1
    let scheduledHandle: any = null
    globalThis.setTimeout = ((_cb: () => void, delay: number) => {
      scheduledDelay = delay
      scheduledHandle = { handle: true }
      return scheduledHandle
    }) as any

    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const prisma = { analyticsDigest: { upsert: async () => ({}) } } as any
    startAnalyticsDigestCollector(prisma)

    // Delay must be between 1 ms (just-past target) and 24 h.
    expect(scheduledDelay).toBeGreaterThan(0)
    expect(scheduledDelay).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    expect(scheduledHandle).not.toBeNull()
    logSpy.mockRestore()
  })

  test('stop clears the scheduled timer (idempotent)', () => {
    let cleared = false
    globalThis.setTimeout = ((_cb: () => void) => 42 as any) as any
    globalThis.clearTimeout = ((h: any) => { if (h === 42) cleared = true }) as any
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    const prisma = { analyticsDigest: { upsert: async () => ({}) } } as any
    startAnalyticsDigestCollector(prisma)
    stopAnalyticsDigestCollector()
    expect(cleared).toBe(true)

    // Second stop is a no-op.
    cleared = false
    stopAnalyticsDigestCollector()
    expect(cleared).toBe(false)
    logSpy.mockRestore()
  })
})
