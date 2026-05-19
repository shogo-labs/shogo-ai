// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/proxy-billing-session.ts — targets the
 * branches the main suite missed:
 *
 *  - `setQualitySignals` (open / closed / merge behavior).
 *  - cache-input + cache-write tokens flow into the metadata.
 *  - `consumeUsage` returning `{ success: false, error }` is logged
 *    but does NOT throw.
 *  - `consumeUsage` throwing is caught and logged.
 *  - `openSession` over an existing session schedules a flush of the
 *    old one (logs "Overwriting existing session").
 *  - `accumulateImageUsage` deduplicates identical model names.
 *  - `recordAgentCostMetric` is fired in a void promise (rejection is
 *    caught, never bubbles).
 *
 *   bun test apps/api/src/__tests__/proxy-billing-session-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

let consumeUsageCalls: any[] = []
let consumeImpl: (args: any) => Promise<any> = async () => ({ success: true, remainingIncludedUsd: 50 })

mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return consumeImpl(args)
  },
}))

let recordAgentCostMetricCalls: any[] = []
let recordImpl: (args: any) => Promise<any> = async () => ({})
mock.module('../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async (args: any) => {
    recordAgentCostMetricCalls.push(args)
    return recordImpl(args)
  },
}))

import {
  openSession,
  closeSession,
  hasSession,
  accumulateUsage,
  accumulateImageUsage,
  setQualitySignals,
} from '../lib/proxy-billing-session'

beforeEach(() => {
  consumeUsageCalls = []
  consumeImpl = async () => ({ success: true, remainingIncludedUsd: 50 })
  recordAgentCostMetricCalls = []
  recordImpl = async () => ({})
})

describe('setQualitySignals', () => {
  test('returns false when no session is open', () => {
    expect(setQualitySignals('proj-no-sess', { success: true })).toBe(false)
  })

  test('returns true and shallow-merges into the existing session', async () => {
    openSession('proj-qm', 'ws-qm', 'user-qm')
    accumulateUsage('proj-qm', 'claude-sonnet-4-5', 100, 50)

    expect(setQualitySignals('proj-qm', { success: true })).toBe(true)
    expect(setQualitySignals('proj-qm', { hitMaxTurns: true })).toBe(true)
    // Later set must NOT clobber earlier fields.
    expect(setQualitySignals('proj-qm', { loopDetected: false })).toBe(true)

    await closeSession('proj-qm')
    expect(consumeUsageCalls).toHaveLength(1)
    // recordAgentCostMetric is fire-and-forget; we just verify it WAS called.
    expect(recordAgentCostMetricCalls).toHaveLength(1)
    const m = recordAgentCostMetricCalls[0]
    expect(m.success).toBe(true)
    expect(m.hitMaxTurns).toBe(true)
    expect(m.loopDetected).toBe(false)
  })
})

describe('cache-input / cache-write token accumulation', () => {
  test('cachedInputTokens and cacheWriteTokens are summed and reported', async () => {
    openSession('proj-cache', 'ws-c', 'user-c')
    accumulateUsage('proj-cache', 'claude-sonnet-4-5', 1000, 200, 800, 600)
    accumulateUsage('proj-cache', 'claude-sonnet-4-5', 500, 100, 200, 300)

    await closeSession('proj-cache')

    expect(consumeUsageCalls).toHaveLength(1)
    const md = consumeUsageCalls[0].actionMetadata
    expect(md.inputTokens).toBe(1500)
    expect(md.outputTokens).toBe(300)
    expect(md.cachedInputTokens).toBe(1000)
    expect(md.cacheWriteTokens).toBe(900)
    expect(md.totalTokens).toBe(1500 + 1000 + 900 + 300)
  })
})

describe('consumeUsage failure surfaces', () => {
  test('success:false from consumeUsage is logged but does not throw', async () => {
    consumeImpl = async () => ({ success: false, error: 'insufficient-credits' })
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    openSession('proj-fail-soft', 'ws-fs', 'user-fs')
    accumulateUsage('proj-fail-soft', 'claude-sonnet-4-5', 100, 50)

    const { billedUsd } = await closeSession('proj-fail-soft')

    expect(billedUsd).toBeGreaterThan(0)
    expect(consumeUsageCalls).toHaveLength(1)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Could not charge usage'))).toBe(true)
    expect(hasSession('proj-fail-soft')).toBe(false)
    warnSpy.mockRestore()
  })

  test('a throwing consumeUsage is caught and logged', async () => {
    consumeImpl = async () => { throw new Error('billing-db-down') }
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})

    openSession('proj-fail-hard', 'ws-fh', 'user-fh')
    accumulateUsage('proj-fail-hard', 'claude-sonnet-4-5', 100, 50)

    const result = await closeSession('proj-fail-hard')

    expect(result.billedUsd).toBeGreaterThan(0) // computed even though debit failed
    expect(consumeUsageCalls).toHaveLength(1)
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Failed to charge usage'))).toBe(true)
    expect(hasSession('proj-fail-hard')).toBe(false)
    errSpy.mockRestore()
  })

  test('a throwing recordAgentCostMetric is caught (fire-and-forget)', async () => {
    recordImpl = async () => { throw new Error('analytics-down') }
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    openSession('proj-rec-fail', 'ws-rf', 'user-rf')
    accumulateUsage('proj-rec-fail', 'claude-sonnet-4-5', 100, 50)

    await closeSession('proj-rec-fail')

    // The cost-analytics rejection is captured asynchronously; give it a tick.
    await new Promise((r) => setTimeout(r, 5))

    expect(consumeUsageCalls).toHaveLength(1) // billing path is unaffected
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Failed to record main-chat cost metric'))).toBe(true)
    warnSpy.mockRestore()
  })
})

describe('openSession overwrite + image dedup', () => {
  test('opening over an existing session logs an overwrite warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    openSession('proj-overwrite-x', 'ws-1', 'user-1')
    accumulateUsage('proj-overwrite-x', 'claude-sonnet-4-5', 1000, 500)
    openSession('proj-overwrite-x', 'ws-2', 'user-2')

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Overwriting existing session'))).toBe(true)
    warnSpy.mockRestore()

    // Wait for the async flush of the old session to settle.
    await new Promise((r) => setTimeout(r, 10))
    // The new session is fresh — closing it without activity returns zero.
    const result = await closeSession('proj-overwrite-x')
    expect(result.totalTokens).toBe(0)
  })

  test('accumulateImageUsage does not duplicate model names in imageModels', async () => {
    openSession('proj-img-dedup', 'ws-1', 'user-1')
    accumulateImageUsage('proj-img-dedup', 'gpt-image-1', 0.04, 0.06)
    accumulateImageUsage('proj-img-dedup', 'gpt-image-1', 0.04, 0.06)
    accumulateImageUsage('proj-img-dedup', 'gpt-image-1', 0.04, 0.06)

    await closeSession('proj-img-dedup')

    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].actionMetadata.imageGenerationCount).toBe(3)
    expect(consumeUsageCalls[0].actionMetadata.imageModels).toEqual(['gpt-image-1'])
  })
})

describe('totalTokens === 0 short-circuit also gates by imageBilledUsd', () => {
  test('zero tokens + nonzero image USD still bills', async () => {
    openSession('proj-img-only-bill', 'ws-i', 'user-i')
    accumulateImageUsage('proj-img-only-bill', 'gpt-image-1', 0.04, 0.06)

    const { billedUsd, totalTokens } = await closeSession('proj-img-only-bill')

    expect(totalTokens).toBe(0)
    expect(billedUsd).toBeCloseTo(0.06, 6)
    expect(consumeUsageCalls).toHaveLength(1)
  })
})

describe('composite (projectId, chatSessionId) keying', () => {
  test('two concurrent sessions on the same project do not collide', async () => {
    openSession('proj-multi', 'ws-1', 'user-A', 'chat-A')
    openSession('proj-multi', 'ws-1', 'user-B', 'chat-B')

    expect(hasSession('proj-multi', 'chat-A')).toBe(true)
    expect(hasSession('proj-multi', 'chat-B')).toBe(true)

    accumulateUsage('proj-multi', 'claude-sonnet-4-5', 100, 50, 0, 0, 'chat-A')
    accumulateUsage('proj-multi', 'claude-sonnet-4-5', 999, 999, 0, 0, 'chat-B')
    accumulateUsage('proj-multi', 'claude-sonnet-4-5', 200, 100, 0, 0, 'chat-A')

    await closeSession('proj-multi', { chatSessionId: 'chat-A' })

    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].memberId).toBe('user-A')
    expect(consumeUsageCalls[0].actionMetadata.inputTokens).toBe(300)
    expect(consumeUsageCalls[0].actionMetadata.outputTokens).toBe(150)
    expect(consumeUsageCalls[0].actionMetadata.chatSessionId).toBe('chat-A')

    // chat-B's tokens are still buffered, intact.
    expect(hasSession('proj-multi', 'chat-A')).toBe(false)
    expect(hasSession('proj-multi', 'chat-B')).toBe(true)

    await closeSession('proj-multi', { chatSessionId: 'chat-B' })
    expect(consumeUsageCalls).toHaveLength(2)
    expect(consumeUsageCalls[1].memberId).toBe('user-B')
    expect(consumeUsageCalls[1].actionMetadata.inputTokens).toBe(999)
    expect(consumeUsageCalls[1].actionMetadata.outputTokens).toBe(999)
    expect(consumeUsageCalls[1].actionMetadata.chatSessionId).toBe('chat-B')
  })

  test('setQualitySignals targets the composite key, not a sibling session', async () => {
    openSession('proj-quality-x', 'ws-q', 'user-q', 'chat-1')
    openSession('proj-quality-x', 'ws-q', 'user-q', 'chat-2')

    accumulateUsage('proj-quality-x', 'claude-sonnet-4-5', 50, 25, 0, 0, 'chat-1')
    accumulateUsage('proj-quality-x', 'claude-sonnet-4-5', 50, 25, 0, 0, 'chat-2')

    setQualitySignals('proj-quality-x', { hitMaxTurns: true }, 'chat-1')

    await closeSession('proj-quality-x', { chatSessionId: 'chat-1' })
    await closeSession('proj-quality-x', { chatSessionId: 'chat-2' })

    expect(recordAgentCostMetricCalls).toHaveLength(2)
    const byChatId: Record<string, any> = {}
    for (const c of recordAgentCostMetricCalls) {
      byChatId[c.metadata?.chatSessionId ?? ''] = c
    }
    expect(byChatId['chat-1'].hitMaxTurns).toBe(true)
    expect(byChatId['chat-2'].hitMaxTurns).toBe(false)
  })

  test('legacy projectId-only callers still work (no chatSessionId)', async () => {
    openSession('proj-legacy', 'ws-l', 'user-l')
    accumulateUsage('proj-legacy', 'claude-sonnet-4-5', 100, 50)

    expect(hasSession('proj-legacy')).toBe(true)
    await closeSession('proj-legacy')
    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].actionMetadata.chatSessionId).toBeUndefined()
  })

  test('accumulateUsage with composite key falls back to legacy projectId-only session', async () => {
    // Older runtime hasn't been redeployed yet — caller opens a legacy
    // session, ai-proxy reports usage with a chatSessionId. Without
    // fallback, usage would be silently dropped.
    openSession('proj-mixed', 'ws-m', 'user-m')
    const ok = accumulateUsage('proj-mixed', 'claude-sonnet-4-5', 100, 50, 0, 0, 'chat-X')
    expect(ok).toBe(true)

    await closeSession('proj-mixed', { chatSessionId: 'chat-X' })
    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].actionMetadata.inputTokens).toBe(100)
  })
})
