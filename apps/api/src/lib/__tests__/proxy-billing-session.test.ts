// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Capture the orphan-GC setInterval callback BEFORE the module is imported
// below. The module schedules a periodic orphan-session sweep at import-time;
// the stub lets the test drive that callback synchronously. Same module-
// load-capture-via-dynamic-import pattern as waves 12 + 22.
let capturedGcCb: (() => void) | null = null
const realSetInterval = globalThis.setInterval
;(globalThis as any).setInterval = (cb: () => void, _ms: number) => {
  capturedGcCb = cb
  return 9999 as any
}

// Mocks must be installed before importing the module under test.
let calcImpl = (inT: number, outT: number, _model: string, cIn = 0, cWr = 0) => ({
  rawUsd: (inT + outT + cIn + cWr) * 0.001,
  billedUsd: (inT + outT + cIn + cWr) * 0.002,
})
mock.module('../../lib/usage-cost', () => ({
  calculateUsageCost: (...a: any[]) => (calcImpl as any)(...a),
  proxyModelToBillingModel: (m: string) => `billing-${m}`,
}))

const consumeUsageCalls: any[] = []
let consumeUsageImpl: (args: any) => Promise<any> = async () => ({ success: true, remainingIncludedUsd: 5 })
mock.module('../../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return consumeUsageImpl(args)
  },
}))

const costMetricCalls: any[] = []
let costMetricImpl: (args: any) => Promise<void> = async () => {}
mock.module('../../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async (args: any) => {
    costMetricCalls.push(args)
    return costMetricImpl(args)
  },
}))

const {
  openSession,
  hasSession,
  accumulateUsage,
  accumulateImageUsage,
  setQualitySignals,
  closeSession,
} = await import('../proxy-billing-session')

;(globalThis as any).setInterval = realSetInterval

const origConsole = { log: console.log, warn: console.warn, error: console.error }
const logs: { log: any[][]; warn: any[][]; error: any[][] } = { log: [], warn: [], error: [] }

beforeEach(() => {
  consumeUsageCalls.length = 0
  consumeUsageImpl = async () => ({ success: true, remainingIncludedUsd: 5 })
  costMetricCalls.length = 0
  costMetricImpl = async () => {}
  calcImpl = (inT, outT, _m, cIn = 0, cWr = 0) => ({
    rawUsd: (inT + outT + cIn + cWr) * 0.001,
    billedUsd: (inT + outT + cIn + cWr) * 0.002,
  })
  logs.log.length = 0
  logs.warn.length = 0
  logs.error.length = 0
  console.log = (...a) => logs.log.push(a)
  console.warn = (...a) => logs.warn.push(a)
  console.error = (...a) => logs.error.push(a)
})

afterEach(async () => {
  // Drain any leftover sessions so cross-test contamination can't happen.
  await closeSession('p').catch(() => {})
  await closeSession('p', { chatSessionId: 'c1' }).catch(() => {})
  await closeSession('p1').catch(() => {})
  await closeSession('p1', { chatSessionId: 'c1' }).catch(() => {})
  await closeSession('p2').catch(() => {})
  console.log = origConsole.log
  console.warn = origConsole.warn
  console.error = origConsole.error
})

describe('openSession + hasSession', () => {
  it('opens a session keyed by projectId when no chatSessionId is given', () => {
    expect(hasSession('p1')).toBe(false)
    openSession('p1', 'w1', 'u1')
    expect(hasSession('p1')).toBe(true)
    expect(hasSession('p1', 'c1')).toBe(false)
  })

  it('opens distinct composite-keyed sessions for the same projectId', () => {
    openSession('p1', 'w1', 'u1', 'cA')
    openSession('p1', 'w1', 'u1', 'cB')
    expect(hasSession('p1', 'cA')).toBe(true)
    expect(hasSession('p1', 'cB')).toBe(true)
  })

  it('overwrites an existing legacy-keyed session and warns', async () => {
    openSession('p1', 'w1', 'u1')
    openSession('p1', 'w2', 'u2')
    expect(logs.warn.length).toBeGreaterThanOrEqual(1)
    expect(String(logs.warn[0])).toContain('Overwriting existing session')
  })

  it('elevates to console.error when re-opening with a composite key', () => {
    openSession('p1', 'w1', 'u1', 'cA')
    openSession('p1', 'w2', 'u2', 'cA')
    expect(logs.error.length).toBeGreaterThanOrEqual(1)
  })

  it('swallows closeSession failure when overwriting an existing session (closes the inline .catch arrow at L109)', async () => {
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 10, 20)
    const origCalc = calcImpl
    calcImpl = (() => { throw new Error('calc-explode-overwrite') }) as any
    try {
      // Second open with same legacy key triggers the inline
      // `closeSession(...).catch(() => {})` branch, which must not throw.
      expect(() => openSession('p1', 'w2', 'u2')).not.toThrow()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    } finally {
      calcImpl = origCalc
    }
  })
})

describe('accumulateUsage', () => {
  it('returns false when no session exists', () => {
    expect(accumulateUsage('nope', 'sonnet', 10, 20)).toBe(false)
  })

  it('accumulates token counts and sets model on legacy-keyed session', () => {
    openSession('p1', 'w1', 'u1')
    expect(accumulateUsage('p1', 'sonnet', 10, 20, 3, 4)).toBe(true)
    expect(accumulateUsage('p1', 'haiku', 5, 6)).toBe(true)
  })

  it('prefers composite-keyed session over legacy when chatSessionId is supplied', async () => {
    openSession('p1', 'w1', 'u1') // legacy
    openSession('p1', 'w1', 'u1', 'cA') // composite
    expect(accumulateUsage('p1', 'sonnet', 100, 100, 0, 0, 'cA')).toBe(true)
    const r = await closeSession('p1', { chatSessionId: 'cA' })
    expect(r.totalTokens).toBe(200)
  })

  it('falls back to legacy session when composite lookup misses', async () => {
    openSession('p1', 'w1', 'u1') // only legacy exists
    expect(accumulateUsage('p1', 'sonnet', 10, 20, 0, 0, 'cMissing')).toBe(true)
    const r = await closeSession('p1') // close legacy
    expect(r.totalTokens).toBe(30)
  })
})

describe('accumulateImageUsage', () => {
  it('returns false when no session', () => {
    expect(accumulateImageUsage('p1', 'sd-xl', 0.1, 0.2)).toBe(false)
  })

  it('accumulates image usd + dedupes model list', async () => {
    openSession('p1', 'w1', 'u1')
    accumulateImageUsage('p1', 'sd-xl', 0.1, 0.2)
    accumulateImageUsage('p1', 'sd-xl', 0.1, 0.2) // duplicate model
    accumulateImageUsage('p1', 'midjourney', 0.05, 0.1)
    const r = await closeSession('p1')
    expect(r.rawUsd).toBeCloseTo(0.25, 5)
    expect(r.billedUsd).toBeCloseTo(0.5, 5)
    const metaCall = consumeUsageCalls[0]
    expect(metaCall.actionMetadata.imageGenerationCount).toBe(3)
    expect(metaCall.actionMetadata.imageModels).toEqual(['sd-xl', 'midjourney'])
  })
})

describe('setQualitySignals', () => {
  it('returns false when no session', () => {
    expect(setQualitySignals('p1', { success: true })).toBe(false)
  })

  it('merges signals and forwards them into cost metric', async () => {
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 10, 20)
    expect(setQualitySignals('p1', { success: true, hitMaxTurns: false })).toBe(true)
    expect(setQualitySignals('p1', { loopDetected: true })).toBe(true)
    await closeSession('p1')
    expect(costMetricCalls).toHaveLength(1)
    expect(costMetricCalls[0].success).toBe(true)
    expect(costMetricCalls[0].loopDetected).toBe(true)
    expect(costMetricCalls[0].hitMaxTurns).toBe(false)
  })
})

describe('closeSession', () => {
  it('returns zeros when there is no session at all', async () => {
    const r = await closeSession('nope')
    expect(r).toEqual({ billedUsd: 0, rawUsd: 0, totalTokens: 0 })
  })

  it('returns zeros when session is empty (no tokens, no images)', async () => {
    openSession('p1', 'w1', 'u1')
    const r = await closeSession('p1')
    expect(r).toEqual({ billedUsd: 0, rawUsd: 0, totalTokens: 0 })
    expect(consumeUsageCalls).toHaveLength(0)
  })

  it('discardPartial:true skips charging but still drains the session', async () => {
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 100, 200)
    const r = await closeSession('p1', { discardPartial: true })
    expect(r.billedUsd).toBe(0)
    expect(r.totalTokens).toBe(300)
    expect(consumeUsageCalls).toHaveLength(0)
    expect(hasSession('p1')).toBe(false)
    expect(String(logs.log[0])).toContain('Discarded partial session')
  })

  it('charges via billing service and forwards full metadata', async () => {
    openSession('p1', 'w1', 'u1', 'chat-z')
    accumulateUsage('p1', 'sonnet', 1000, 500, 100, 50, 'chat-z')
    accumulateImageUsage('p1', 'sd-xl', 0.05, 0.1, 'chat-z')
    const r = await closeSession('p1', { chatSessionId: 'chat-z' })
    expect(consumeUsageCalls).toHaveLength(1)
    const arg = consumeUsageCalls[0]
    expect(arg.workspaceId).toBe('w1')
    expect(arg.memberId).toBe('u1')
    expect(arg.actionType).toBe('chat_message')
    expect(arg.actionMetadata.totalTokens).toBe(1650)
    expect(arg.actionMetadata.chatSessionId).toBe('chat-z')
    expect(arg.actionMetadata.billingModel).toBe('billing-sonnet')
    expect(arg.actionMetadata.imageBilledUsd).toBe(0.1)
    expect(r.totalTokens).toBe(1650)
    expect(String(logs.log.find((l) => String(l[0]).includes('Charged'))?.[0])).toMatch(/Charged \$/)
  })

  it('falls back to legacy key when caller forgets to pass chatSessionId on close', async () => {
    openSession('p1', 'w1', 'u1') // legacy
    accumulateUsage('p1', 'sonnet', 100, 100)
    const r = await closeSession('p1', { chatSessionId: 'never-opened' })
    expect(r.totalTokens).toBe(200)
    expect(hasSession('p1')).toBe(false)
  })

  it('warns when billing returns success:false', async () => {
    consumeUsageImpl = async () => ({ success: false, error: 'no credits' })
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 10, 20)
    await closeSession('p1')
    expect(logs.warn.some((w) => String(w[0]).includes('Could not charge'))).toBe(true)
  })

  it('logs error when billing service throws', async () => {
    consumeUsageImpl = async () => { throw new Error('db down') }
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 10, 20)
    await closeSession('p1')
    expect(logs.error.some((e) => String(e[0]).includes('Failed to charge'))).toBe(true)
  })

  it('catches recordAgentCostMetric failures without surfacing them', async () => {
    costMetricImpl = async () => { throw new Error('analytics down') }
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 10, 20)
    await closeSession('p1')
    // Give the void-promise time to settle
    await new Promise((r) => setTimeout(r, 10))
    expect(logs.warn.some((w) => String(w[0]).includes('Failed to record main-chat cost metric'))).toBe(true)
  })

  it('omits chatSessionId metadata when session was opened without one', async () => {
    openSession('p1', 'w1', 'u1')
    accumulateUsage('p1', 'sonnet', 10, 20)
    await closeSession('p1')
    expect(consumeUsageCalls[0].actionMetadata.chatSessionId).toBeUndefined()
  })

  it('still charges when only image usage is present (no tokens)', async () => {
    openSession('p1', 'w1', 'u1')
    accumulateImageUsage('p1', 'sd-xl', 0.1, 0.2)
    const r = await closeSession('p1')
    expect(r.billedUsd).toBeGreaterThan(0)
    expect(r.totalTokens).toBe(0)
    expect(consumeUsageCalls).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Orphan-session GC (module-load setInterval callback)
// Closes L72-82 + the 2 uncovered functions (the setInterval arrow and
// its inline .catch arrow).
// ═══════════════════════════════════════════════════════════════════════

describe('orphan-session GC', () => {
  const origDateNow = Date.now
  afterEach(() => {
    Date.now = origDateNow
  })

  it('captured the setInterval callback at module load', () => {
    expect(typeof capturedGcCb).toBe('function')
  })

  it('no-op when no sessions are open', () => {
    expect(() => capturedGcCb!()).not.toThrow()
  })

  it('no-op when sessions exist but none are past the timeout', async () => {
    openSession('p_fresh', 'ws_x', 'u_x', 'cs_fresh')
    const before = logs.warn.length
    capturedGcCb!()
    expect(logs.warn.length).toBe(before)
    await closeSession('p_fresh', { chatSessionId: 'cs_fresh' })
  })

  it('flushes orphaned sessions and logs a warning (closes L72-80 happy path)', async () => {
    openSession('p_old', 'ws_x', 'u_x', 'cs_old')
    Date.now = () => origDateNow() + 11 * 60 * 1000
    capturedGcCb!()
    const orphanLogs = logs.warn.filter((a) =>
      String(a[0]).includes('Flushing orphaned session for p_old:cs_old'),
    )
    expect(orphanLogs.length).toBeGreaterThanOrEqual(1)
    await new Promise((r) => setImmediate(r))
  })

  it('inline .catch arrow fires when closeSession rejects (closes L77-79 + the catch-arrow function)', async () => {
    openSession('p_boom', 'ws_x', 'u_x', 'cs_boom')
    accumulateUsage('p_boom', 'sonnet', 100, 200, 0, 0, 'cs_boom')
    Date.now = () => origDateNow() + 11 * 60 * 1000
    // closeSession internally catches consumeUsage failures, so reject it
    // upstream by making calculateUsageCost throw synchronously — that
    // unhandled throw propagates out of closeSession and the inline
    // .catch arrow at L77 finally has something to handle.
    const origCalc = calcImpl
    calcImpl = (() => { throw new Error('calc-explode') }) as any
    try {
      capturedGcCb!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      const errMsgs = logs.error.filter((a) =>
        String(a[0]).includes('Failed to flush orphaned session'),
      )
      expect(errMsgs.length).toBeGreaterThanOrEqual(1)
    } finally {
      calcImpl = origCalc
    }
  })
})
