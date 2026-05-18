// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Error-path + scheduler coverage for `src/jobs/voice-monthly-rebill.ts`.
 *
 * The base suite (`voice-monthly-rebill.test.ts`) pins the happy-path
 * debit / idempotency / skipping contract. This file covers what's left:
 *
 *   - line 88-96  → debit returns { success:false } → warn + failed++,
 *                   watermark intentionally NOT advanced (so the next
 *                   run retries)
 *   - line 106-107 → consumeUsage throws synchronously → failed++ via
 *                   the for-loop's try/catch
 *   - line 134-139 → startVoiceMonthlyRebillCron schedules a deferred
 *                   initial run and a recurring setInterval with the
 *                   provided cadence, logs once at boot
 *
 * We mock prisma + billing.service the same way the base suite does
 * but expose a `failNext` switch on `consumeUsage` so a single test can
 * flip it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

interface VoiceCfg {
  projectId: string
  workspaceId: string
  twilioPhoneSid: string | null
  twilioPhoneNumber: string | null
  monthlyRateDebitedFor: Date | null
}

let rows: VoiceCfg[] = []
let updatedWatermarks: Array<{ projectId: string; to: Date }> = []
let consumeBehavior: 'success' | 'failure' | 'throw' | 'mixed' = 'success'
let mixedSequence: Array<{ success: boolean; error?: string; remainingUsd?: number }> = []

mock.module('../lib/prisma', () => ({
  prisma: {
    voiceProjectConfig: {
      findMany: async ({ where }: any) => {
        const period = where.OR[1]?.monthlyRateDebitedFor?.lt as Date
        return rows.filter(
          (r) =>
            r.twilioPhoneSid !== null &&
            (r.monthlyRateDebitedFor === null ||
              r.monthlyRateDebitedFor < period),
        )
      },
      update: async ({ where, data }: any) => {
        updatedWatermarks.push({ projectId: where.projectId, to: data.monthlyRateDebitedFor })
        const r = rows.find((x) => x.projectId === where.projectId)
        if (r) r.monthlyRateDebitedFor = data.monthlyRateDebitedFor
        return r
      },
    },
  },
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async () => {
    if (consumeBehavior === 'throw') throw new Error('billing exploded')
    if (consumeBehavior === 'failure') return { success: false, error: 'usage_limit_reached' }
    if (consumeBehavior === 'mixed') return mixedSequence.shift() ?? { success: true, remainingUsd: 99 }
    return { success: true, remainingUsd: 99 }
  },
}))

const originalWarn = console.warn
const originalError = console.error
const originalLog = console.log
const warnSpy = mock((..._args: any[]) => {})
const errorSpy = mock((..._args: any[]) => {})
const logSpy = mock((..._args: any[]) => {})

beforeEach(() => {
  rows = []
  updatedWatermarks = []
  consumeBehavior = 'success'
  mixedSequence = []
  warnSpy.mockClear()
  errorSpy.mockClear()
  logSpy.mockClear()
  console.warn = warnSpy as any
  console.error = errorSpy as any
  console.log = logSpy as any
})

afterEach(() => {
  console.warn = originalWarn
  console.error = originalError
  console.log = originalLog
})

afterAll(() => {
  console.warn = originalWarn
  console.error = originalError
  console.log = originalLog
})

const { runVoiceMonthlyRebill, startVoiceMonthlyRebillCron } = await import('../jobs/voice-monthly-rebill')

// ─── failed-debit branch ──────────────────────────────────────────────

describe('runVoiceMonthlyRebill — failed debit', () => {
  test('debit returning { success:false } increments failed and does NOT advance the watermark', async () => {
    consumeBehavior = 'failure'
    rows = [
      {
        projectId: 'p_fail',
        workspaceId: 'w1',
        twilioPhoneSid: 'PN1',
        twilioPhoneNumber: '+14155550001',
        monthlyRateDebitedFor: null,
      },
    ]
    const summary = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T12:00:00Z') })
    expect(summary.processed).toBe(1)
    expect(summary.debited).toBe(0)
    expect(summary.failed).toBe(1)
    expect(updatedWatermarks).toEqual([])
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    // Confirm the warn payload contains the failure reason for ops triage.
    const found = warnSpy.mock.calls.some(
      (c) => JSON.stringify(c).includes('usage_limit_reached'),
    )
    expect(found).toBe(true)
  })

  test('mixed success/failure in a single cycle increments both counters and only advances the successful watermark', async () => {
    rows = [
      { projectId: 'p_ok',   workspaceId: 'w1', twilioPhoneSid: 'A', twilioPhoneNumber: '+1', monthlyRateDebitedFor: null },
      { projectId: 'p_bad',  workspaceId: 'w2', twilioPhoneSid: 'B', twilioPhoneNumber: '+2', monthlyRateDebitedFor: null },
    ]
    // First debit succeeds, second fails — sequenced via mixedSequence[].
    mixedSequence = [{ success: true }, { success: false, error: 'denied' }]
    consumeBehavior = 'mixed'
    const summary = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T12:00:00Z') })
    expect(summary.debited).toBe(1)
    expect(summary.failed).toBe(1)
    expect(updatedWatermarks.map((u) => u.projectId)).toEqual(['p_ok'])
  })
})

// ─── thrown-exception branch ──────────────────────────────────────────

describe('runVoiceMonthlyRebill — synchronous throw inside the loop', () => {
  test('consumeUsage throwing is caught, failed++, and the loop continues to the next row', async () => {
    consumeBehavior = 'throw'
    rows = [
      { projectId: 'pX', workspaceId: 'w1', twilioPhoneSid: 'A', twilioPhoneNumber: '+1', monthlyRateDebitedFor: null },
      { projectId: 'pY', workspaceId: 'w2', twilioPhoneSid: 'B', twilioPhoneNumber: '+2', monthlyRateDebitedFor: null },
    ]
    const summary = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T12:00:00Z') })
    expect(summary.processed).toBe(2)
    expect(summary.failed).toBe(2)
    expect(summary.debited).toBe(0)
    expect(updatedWatermarks).toEqual([])
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── startVoiceMonthlyRebillCron ──────────────────────────────────────

describe('startVoiceMonthlyRebillCron', () => {
  const realSetTimeout = global.setTimeout
  const realSetInterval = global.setInterval

  afterEach(() => {
    global.setTimeout = realSetTimeout
    global.setInterval = realSetInterval
  })

  test('logs a one-time scheduling notice including the cadence in hours', () => {
    const setTimeoutSpy = mock((_fn: any, _ms: any) => 0 as any)
    const setIntervalSpy = mock((_fn: any, _ms: any) => 0 as any)
    global.setTimeout = setTimeoutSpy as any
    global.setInterval = setIntervalSpy as any
    startVoiceMonthlyRebillCron(60 * 60 * 1000) // 1h
    expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(
      logSpy.mock.calls.some((c) => JSON.stringify(c).includes('every 1h')),
    ).toBe(true)
  })

  test('defers the initial run by 20s via setTimeout and only schedules setInterval after firing', () => {
    const setTimeoutSpy = mock((_fn: any, ms: any) => {
      expect(ms).toBe(20_000)
      return 1 as any
    })
    const setIntervalSpy = mock((_fn: any, _ms: any) => 1 as any)
    global.setTimeout = setTimeoutSpy as any
    global.setInterval = setIntervalSpy as any
    startVoiceMonthlyRebillCron()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    // setInterval is set up INSIDE the deferred initial run, so until the
    // timeout fires it should not have been called at all.
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  test('rounds the cadence in the log message (12h cadence → "every 12h")', () => {
    global.setTimeout = mock(() => 0 as any) as any
    global.setInterval = mock(() => 0 as any) as any
    startVoiceMonthlyRebillCron(12 * 60 * 60 * 1000)
    expect(
      logSpy.mock.calls.some((c) => JSON.stringify(c).includes('every 12h')),
    ).toBe(true)
  })

  test('after the 20s timeout fires, both the initial runner runs and a setInterval is installed', async () => {
    let timeoutFn: () => void = () => {}
    global.setTimeout = ((fn: any, _ms: any) => {
      timeoutFn = fn
      return 1 as any
    }) as any
    const setIntervalSpy = mock((_fn: any, _ms: any) => 1 as any)
    global.setInterval = setIntervalSpy as any
    startVoiceMonthlyRebillCron(24 * 60 * 60 * 1000)
    // Fire the deferred initial run
    timeoutFn()
    // setInterval should now be scheduled
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(24 * 60 * 60 * 1000)
    // Drain microtasks so the catch handler attaches
    await Promise.resolve()
  })

  test('default cadence is 24h when no argument is supplied', () => {
    const setIntervalSpy = mock((_fn: any, _ms: any) => 1 as any)
    let timeoutFn: () => void = () => {}
    global.setTimeout = ((fn: any) => { timeoutFn = fn; return 1 as any }) as any
    global.setInterval = setIntervalSpy as any
    startVoiceMonthlyRebillCron()
    timeoutFn()
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(24 * 60 * 60 * 1000)
  })
})
