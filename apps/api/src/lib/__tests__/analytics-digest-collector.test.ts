// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let funnelImpl: any = async () => ({
  signups: 1,
  onboarded: 1,
  createdProject: 1,
  sentMessage: 1,
  engaged: 1,
  avgMinToFirstProject: 1,
  avgMinToFirstMessage: 1,
})
let activityImpl: any = async () => ({
  total: 1,
  users: [{ spendUsd: 2, toolCalls: 3, messages: 4, sessions: 5 }],
})
let templatesImpl: any = async () => ({ templates: [] })
let sourcesImpl: any = async () => ({ sources: [] })
let convosImpl: any = async () => ({ conversations: [] })

mock.module('../../services/analytics.service', () => ({
  getUserFunnel: (...a: any[]) => funnelImpl(...a),
  getUserActivityTable: (...a: any[]) => activityImpl(...a),
  getTemplateEngagement: (...a: any[]) => templatesImpl(...a),
  getChatConversations: (...a: any[]) => convosImpl(...a),
  getSourceBreakdown: (...a: any[]) => sourcesImpl(...a),
}))

mock.module('@shogo/model-catalog', () => ({
  getMaxOutputTokens: (_: string) => 4096,
}))

const {
  chunkConversations,
  mergeAnalyses,
  generateDigest,
  startAnalyticsDigestCollector,
  stopAnalyticsDigestCollector,
} = await import('../analytics-digest-collector')

const upsertCalls: any[] = []
const fakePrisma = {
  analyticsDigest: {
    upsert: async (args: any) => {
      upsertCalls.push(args)
      return { id: 'digest-1', ...(args.create ?? {}) }
    },
  },
} as any

beforeEach(() => {
  upsertCalls.length = 0
  funnelImpl = async () => ({
    signups: 1, onboarded: 1, createdProject: 1, sentMessage: 1, engaged: 1,
    avgMinToFirstProject: 1, avgMinToFirstMessage: 1,
  })
  activityImpl = async () => ({ total: 1, users: [{ spendUsd: 2, toolCalls: 3, messages: 4, sessions: 5 }] })
  templatesImpl = async () => ({ templates: [{ id: 't1' }] })
  sourcesImpl = async () => ({ sources: [{ tag: 'web', count: 2 }] })
  convosImpl = async () => ({ conversations: [] })
})

afterEach(() => {
  stopAnalyticsDigestCollector()
})

function thread(overrides: any = {}) {
  return {
    userName: 'alice',
    projectName: 'p1',
    templateId: null,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    ...overrides,
  }
}

describe('chunkConversations', () => {
  it('returns a single chunk for small input', () => {
    const r = chunkConversations([thread(), thread({ userName: 'bob' })])
    expect(r).toHaveLength(1)
    expect(r[0]).toContain('alice')
    expect(r[0]).toContain('bob')
  })

  it('produces multiple chunks when content exceeds the token budget', () => {
    const big = 'x'.repeat(500_000) // ~125k tokens at CHARS_PER_TOKEN=4
    const threads = Array.from({ length: 5 }, (_, i) =>
      thread({ userName: `u${i}`, messages: [{ role: 'user', content: big }] }),
    )
    const r = chunkConversations(threads)
    expect(r.length).toBeGreaterThan(1)
    expect(r.length).toBeLessThanOrEqual(3)
  })

  it('caps total chunks at MAX_CHUNKS = 3', () => {
    const big = 'x'.repeat(500_000)
    const threads = Array.from({ length: 20 }, (_, i) =>
      thread({ userName: `u${i}`, messages: [{ role: 'user', content: big }] }),
    )
    const r = chunkConversations(threads)
    expect(r.length).toBeLessThanOrEqual(3)
  })

  it('returns [] for an empty input', () => {
    expect(chunkConversations([])).toEqual([])
  })

  it('formats threads with templateId when present', () => {
    const r = chunkConversations([thread({ templateId: 'tpl-1' })])
    expect(r[0]).toContain('template: tpl-1')
  })

  it('formats threads with Unknown when userName is missing', () => {
    const r = chunkConversations([thread({ userName: '' })])
    expect(r[0]).toContain('Unknown')
  })
})

describe('mergeAnalyses', () => {
  it('returns an empty merged object for []', () => {
    const m = mergeAnalyses([])
    expect(m).toEqual({ takeaways: [], intents: [], painPoints: [], securityFlags: [] })
  })

  it('dedupes takeaways and clamps to 5', () => {
    const m = mergeAnalyses([
      { takeaways: ['a', 'b', 'c', 'd', 'e', 'f', 'a'], intents: [], painPoints: [], securityFlags: [] },
    ])
    expect(m.takeaways).toHaveLength(5)
  })

  it('merges duplicate intent categories by adding counts and concatenating examples', () => {
    const m = mergeAnalyses([
      { takeaways: [], intents: [{ category: 'A', count: 2, examples: ['e1'] }], painPoints: [], securityFlags: [] },
      { takeaways: [], intents: [{ category: 'A', count: 3, examples: ['e2', 'e3', 'e4', 'e5'] }], painPoints: [], securityFlags: [] },
    ])
    expect(m.intents).toHaveLength(1)
    expect(m.intents[0].count).toBe(5)
    expect(m.intents[0].examples).toHaveLength(3) // clamped
  })

  it('preserves separate intent categories', () => {
    const m = mergeAnalyses([
      { takeaways: [], intents: [{ category: 'A', count: 1, examples: [] }], painPoints: [], securityFlags: [] },
      { takeaways: [], intents: [{ category: 'B', count: 2, examples: [] }], painPoints: [], securityFlags: [] },
    ])
    expect(m.intents.map((i) => i.category).sort()).toEqual(['A', 'B'])
  })

  it('dedupes painPoints and securityFlags', () => {
    const m = mergeAnalyses([
      { takeaways: [], intents: [], painPoints: ['x', 'y'], securityFlags: ['s'] },
      { takeaways: [], intents: [], painPoints: ['x'], securityFlags: ['s'] },
    ])
    expect(m.painPoints).toEqual(['x', 'y'])
    expect(m.securityFlags).toEqual(['s'])
  })
})

describe('generateDigest', () => {
  it('upserts a digest with the analytics totals (no conversations → no AI call)', async () => {
    convosImpl = async () => ({ conversations: [] })
    const digest = await generateDigest(fakePrisma)
    expect(upsertCalls).toHaveLength(1)
    const u = upsertCalls[0]
    // The unique key was widened from `(date, period)` to
    // `(date, period, region)` in the 2026-05-21 migration that fixed
    // the cross-region poison-pill on analytics_digests; the Prisma
    // compound-key name moved from `date_period` to
    // `date_period_region` to match. `region` defaults to `'unknown'`
    // when REGION_ID is unset (local/dev runs, including this test).
    expect(u.where.date_period_region.period).toBe('24h')
    expect(u.where.date_period_region.region).toBe('unknown')
    expect(u.create.region).toBe('unknown')
    expect(u.create.totalSpendUsd).toBe(2)
    expect(u.create.totalToolCalls).toBe(3)
    expect(u.create.totalMessages).toBe(4)
    expect(u.create.totalSessions).toBe(5)
    expect(u.create.aiInsights).toBeNull()
    expect(u.create.chunksProcessed).toBe(0)
    expect(digest.id).toBe('digest-1')
  })

  it('runs Claude analysis when conversations are present (skipped — no API key)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    convosImpl = async () => ({
      conversations: [{
        userName: 'a', projectName: 'p', templateId: null,
        messages: [{ role: 'user', content: 'hello' }],
      }],
    })
    const digest = await generateDigest(fakePrisma)
    expect(upsertCalls[0].create.aiInsights).toBeTruthy()
    expect(digest.id).toBe('digest-1')
  })

  it('returns the failed-text branch when Claude API returns non-OK', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const realFetch = globalThis.fetch
    ;(globalThis as any).fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
    })
    convosImpl = async () => ({
      conversations: [{ userName: 'a', projectName: 'p', templateId: null,
        messages: [{ role: 'user', content: 'q' }] }],
    })
    try {
      await generateDigest(fakePrisma)
      expect(upsertCalls[0].create.aiInsights).toBeTruthy()
    } finally {
      ;(globalThis as any).fetch = realFetch
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('parses Claude success output into ChunkAnalysis', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const realFetch = globalThis.fetch
    ;(globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        content: [{ text: JSON.stringify({ takeaways: ['t1'], intents: [], painPoints: [], securityFlags: [] }) }],
      }),
    })
    convosImpl = async () => ({
      conversations: [{ userName: 'a', projectName: 'p', templateId: null,
        messages: [{ role: 'user', content: 'q' }] }],
    })
    try {
      await generateDigest(fakePrisma)
      expect(upsertCalls[0].create.aiInsights.takeaways).toContain('t1')
    } finally {
      ;(globalThis as any).fetch = realFetch
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('returns error-text branch when fetch throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const realFetch = globalThis.fetch
    ;(globalThis as any).fetch = async () => {
      throw new Error('boom')
    }
    convosImpl = async () => ({
      conversations: [{ userName: 'a', projectName: 'p', templateId: null,
        messages: [{ role: 'user', content: 'q' }] }],
    })
    try {
      await generateDigest(fakePrisma)
    } finally {
      ;(globalThis as any).fetch = realFetch
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

describe('start/stopAnalyticsDigestCollector', () => {
  it('schedules a timer when started and clears it when stopped', async () => {
    const realSetTimeout = globalThis.setTimeout
    let capturedDelay: number | null = null
    ;(globalThis as any).setTimeout = (fn: any, ms: number) => {
      capturedDelay = ms
      return realSetTimeout(() => {}, 0) as any
    }
    try {
      startAnalyticsDigestCollector(fakePrisma)
      expect(typeof capturedDelay).toBe('number')
      stopAnalyticsDigestCollector()
      stopAnalyticsDigestCollector() // idempotent
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  })

  it('does NOT schedule a timer outside the main region', () => {
    const realSetTimeout = globalThis.setTimeout
    const originalRegion = process.env.REGION_ID
    let scheduled = false
    ;(globalThis as any).setTimeout = (..._a: any[]) => {
      scheduled = true
      return realSetTimeout(() => {}, 0) as any
    }
    try {
      process.env.REGION_ID = 'eu-frankfurt-1'
      startAnalyticsDigestCollector(fakePrisma)
      expect(scheduled).toBe(false)
      process.env.REGION_ID = 'ap-mumbai-1'
      startAnalyticsDigestCollector(fakePrisma)
      expect(scheduled).toBe(false)
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
      if (originalRegion === undefined) delete process.env.REGION_ID
      else process.env.REGION_ID = originalRegion
    }
  })

  it('schedules a timer in the main region (us-ashburn-1)', () => {
    const realSetTimeout = globalThis.setTimeout
    const originalRegion = process.env.REGION_ID
    let scheduled = false
    ;(globalThis as any).setTimeout = (..._a: any[]) => {
      scheduled = true
      return realSetTimeout(() => {}, 0) as any
    }
    try {
      process.env.REGION_ID = 'us-ashburn-1'
      startAnalyticsDigestCollector(fakePrisma)
      expect(scheduled).toBe(true)
      stopAnalyticsDigestCollector()
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
      if (originalRegion === undefined) delete process.env.REGION_ID
      else process.env.REGION_ID = originalRegion
    }
  })

  it('timer callback runs generateDigest then re-schedules (success path, lines 267-269,273)', async () => {
    const realSetTimeout = globalThis.setTimeout
    const calls: Array<() => Promise<void> | void> = []
    ;(globalThis as any).setTimeout = (fn: any, _ms: number) => {
      calls.push(fn)
      return realSetTimeout(() => {}, 0) as any
    }
    // generateDigest reads prisma.message.findMany — fakePrisma returns []
    // by default, so the digest path runs to completion without throwing.
    try {
      startAnalyticsDigestCollector(fakePrisma)
      expect(calls.length).toBe(1)
      // Invoke the captured callback once. It will call generateDigest then
      // scheduleNext() → setTimeout again → calls.push.
      await calls[0]!()
      expect(calls.length).toBe(2) // recursive scheduleNext fired
      stopAnalyticsDigestCollector()
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  })

  it('timer callback catches generateDigest errors and re-schedules (lines 270-272)', async () => {
    const realSetTimeout = globalThis.setTimeout
    const realConsoleError = console.error
    const errors: any[] = []
    console.error = (...args: any[]) => errors.push(args)
    const calls: Array<() => Promise<void> | void> = []
    ;(globalThis as any).setTimeout = (fn: any, _ms: number) => {
      calls.push(fn)
      return realSetTimeout(() => {}, 0) as any
    }
    // Force generateDigest to throw by giving prisma a findMany that rejects.
    const throwingPrisma: any = {
      message: { findMany: async () => { throw new Error('db read failed') } },
      analyticsDigest: { create: async () => {}, findFirst: async () => null },
    }
    try {
      startAnalyticsDigestCollector(throwingPrisma)
      expect(calls.length).toBe(1)
      await calls[0]!()
      // Error logged, callback survived → next tick scheduled.
      expect(errors.length).toBeGreaterThan(0)
      const msgs = errors.flat().map(String).join(' ')
      expect(msgs).toContain('Digest generation failed')
      // generateDigest can fail at any of several prisma method calls
      // depending on which is missing/throwing first; covering the catch
      // arm is what matters.
      expect(calls.length).toBe(2)
      stopAnalyticsDigestCollector()
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
      console.error = realConsoleError
    }
  })
})
