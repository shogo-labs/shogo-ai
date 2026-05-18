// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/jobs/grant-monthly-refill.ts — targets the two
 * uncovered branches the main suite missed:
 *
 *  - L86-87: the `failed += 1; console.error(...)` catch block when
 *    `applyGrantMonthlyAllocation` (or any prisma read inside the for-loop)
 *    throws.
 *  - L103-119: `startGrantMonthlyRefillCron`'s timer scheduling — the
 *    initial setTimeout fires `runGrantMonthlyRefill` and a subsequent
 *    setInterval keeps firing it. Both error paths log without
 *    throwing.
 *
 *   bun test apps/api/src/__tests__/grant-monthly-refill-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

interface GrantRow {
  workspaceId: string
  monthlyIncludedUsd: number
  startsAt: Date
  expiresAt: Date | null
  workspace: { subscriptions: Array<{ status: string }> }
}
interface WalletRow { workspaceId: string; lastMonthlyReset: Date }

let grantRows: GrantRow[] = []
let walletRows: WalletRow[] = []
let applyImpl: (workspaceId: string, now: Date) => Promise<unknown> =
  async () => ({})

mock.module('../lib/prisma', () => ({
  prisma: {
    workspaceGrant: {
      findMany: async () =>
        grantRows
          .filter((g) => !g.workspace.subscriptions.some((s) => ['active', 'trialing'].includes(s.status)))
          .map((g) => ({ workspaceId: g.workspaceId })),
    },
    usageWallet: {
      findUnique: async ({ where }: any) =>
        walletRows.find((w) => w.workspaceId === where.workspaceId) ?? null,
    },
  },
}))

mock.module('../services/billing.service', () => ({
  applyGrantMonthlyAllocation: (workspaceId: string, now: Date) =>
    applyImpl(workspaceId, now),
}))

const { runGrantMonthlyRefill, startGrantMonthlyRefillCron } = await import(
  '../jobs/grant-monthly-refill'
)

beforeEach(() => {
  grantRows = []
  walletRows = []
  applyImpl = async () => ({})
})

describe('runGrantMonthlyRefill — failure path', () => {
  test('counts a workspace as failed when applyGrantMonthlyAllocation throws', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      { workspaceId: 'ws_boom', monthlyIncludedUsd: 500, startsAt: past, expiresAt: null, workspace: { subscriptions: [] } },
    ]
    walletRows = [
      { workspaceId: 'ws_boom', lastMonthlyReset: new Date('2026-04-15T00:00:00Z') },
    ]
    applyImpl = async () => { throw new Error('stripe-down') }

    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    const summary = await runGrantMonthlyRefill({ now })
    errSpy.mockRestore()

    expect(summary.candidates).toBe(1)
    expect(summary.refilled).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(summary.failed).toBe(1)
  })

  test('mixed batch: refilled / skipped (wallet current) / skipped (no wallet) / failed', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    const past = new Date('2020-01-01T00:00:00Z')
    grantRows = [
      { workspaceId: 'ws_ok', monthlyIncludedUsd: 500, startsAt: past, expiresAt: null, workspace: { subscriptions: [] } },
      { workspaceId: 'ws_current', monthlyIncludedUsd: 500, startsAt: past, expiresAt: null, workspace: { subscriptions: [] } },
      { workspaceId: 'ws_no_wallet', monthlyIncludedUsd: 500, startsAt: past, expiresAt: null, workspace: { subscriptions: [] } },
      { workspaceId: 'ws_explode', monthlyIncludedUsd: 500, startsAt: past, expiresAt: null, workspace: { subscriptions: [] } },
    ]
    walletRows = [
      { workspaceId: 'ws_ok', lastMonthlyReset: new Date('2026-04-15T00:00:00Z') },
      { workspaceId: 'ws_current', lastMonthlyReset: new Date('2026-05-01T00:00:00Z') },
      { workspaceId: 'ws_explode', lastMonthlyReset: new Date('2026-04-15T00:00:00Z') },
    ]
    applyImpl = async (workspaceId) => {
      if (workspaceId === 'ws_explode') throw new Error('db gone')
      return {}
    }

    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    const summary = await runGrantMonthlyRefill({ now })
    errSpy.mockRestore()

    expect(summary.candidates).toBe(4)
    expect(summary.refilled).toBe(1)
    expect(summary.skipped).toBe(2)
    expect(summary.failed).toBe(1)
  })

  test('defaults `now` to the current time when not passed', async () => {
    grantRows = []
    walletRows = []
    const summary = await runGrantMonthlyRefill()
    expect(summary.candidates).toBe(0)
    expect(summary.period.getUTCDate()).toBe(1)
    expect(summary.period.getUTCHours()).toBe(0)
  })

  test('summary.period is always the UTC first-of-month at 00:00:00.000', async () => {
    const summary = await runGrantMonthlyRefill({ now: new Date('2026-12-31T23:59:59.999Z') })
    expect(summary.period.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  test('logs a cycle-complete line only when there were candidates', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    await runGrantMonthlyRefill({ now: new Date('2026-05-15T12:00:00Z') }) // candidates=0
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('cycle complete'))).toBe(false)

    grantRows = [{
      workspaceId: 'ws_a',
      monthlyIncludedUsd: 500,
      startsAt: new Date('2020-01-01T00:00:00Z'),
      expiresAt: null,
      workspace: { subscriptions: [] },
    }]
    await runGrantMonthlyRefill({ now: new Date('2026-05-15T12:00:00Z') })
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('cycle complete'))).toBe(true)
    logSpy.mockRestore()
  })
})

describe('startGrantMonthlyRefillCron — scheduler wiring', () => {
  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.setInterval = realSetInterval
  })

  test('schedules an initial setTimeout and a recurring setInterval', () => {
    let timeoutDelay = -1
    let intervalDelay = -1
    let timeoutCb: (() => void) | null = null
    let intervalCb: (() => void) | null = null

    globalThis.setTimeout = ((cb: () => void, delay: number) => {
      timeoutDelay = delay
      timeoutCb = cb
      return 1 as any
    }) as any
    globalThis.setInterval = ((cb: () => void, delay: number) => {
      intervalDelay = delay
      intervalCb = cb
      return 2 as any
    }) as any
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    startGrantMonthlyRefillCron(60 * 60 * 1000)

    expect(timeoutDelay).toBe(25_000)
    expect(timeoutCb).toBeInstanceOf(Function)
    expect(intervalDelay).toBe(-1) // interval is only created INSIDE the initial timeout
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('grant monthly refill cron scheduled'))).toBe(true)

    timeoutCb!()
    expect(intervalDelay).toBe(60 * 60 * 1000)
    expect(intervalCb).toBeInstanceOf(Function)

    logSpy.mockRestore()
  })

  test('initial-run error is caught (does not propagate)', async () => {
    const realDelay = realSetTimeout
    let timeoutCb: (() => void) | null = null
    globalThis.setTimeout = ((cb: () => void) => { timeoutCb = cb; return 1 as any }) as any
    globalThis.setInterval = ((_cb: () => void) => 2 as any) as any
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})

    grantRows = [{
      workspaceId: 'ws_x',
      monthlyIncludedUsd: 500,
      startsAt: new Date('2020-01-01T00:00:00Z'),
      expiresAt: null,
      workspace: { subscriptions: [] },
    }]
    walletRows = [{ workspaceId: 'ws_x', lastMonthlyReset: new Date('2026-04-15T00:00:00Z') }]
    applyImpl = async () => { throw new Error('initial-boom') }

    startGrantMonthlyRefillCron(60_000)
    timeoutCb!()
    await new Promise((r) => realDelay(r, 5))

    // The error inside runGrantMonthlyRefill is captured per-workspace as `failed`,
    // not surfaced as an unhandled rejection. Scheduler stays alive.
    expect(errSpy.mock.calls.length).toBeGreaterThan(0)
    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  test('uses the default 24h interval when no argument is passed', () => {
    let intervalDelay = -1
    let timeoutCb: (() => void) | null = null
    globalThis.setTimeout = ((cb: () => void) => { timeoutCb = cb; return 1 as any }) as any
    globalThis.setInterval = ((_cb: () => void, delay: number) => { intervalDelay = delay; return 2 as any }) as any
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    startGrantMonthlyRefillCron()
    timeoutCb!()

    expect(intervalDelay).toBe(24 * 60 * 60 * 1000)
    logSpy.mockRestore()
  })
})
