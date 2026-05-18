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
