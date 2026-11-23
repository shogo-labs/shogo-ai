// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Plan refetch on foreground (SHO-469).
 *
 * When the app moves to the foreground after a workspace-plan 500, the hook
 * must re-fetch and unlock models once the endpoint recovers — without a cold
 * start. Repeated foreground events within 60s must be throttled to avoid
 * hammering the endpoint.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import React from 'react'
import { installHappyDom, restoreHappyDom } from './happy-dom-setup.ts'

// --- Mocks set up before the module under test is imported ---

let planResponse: () => Promise<unknown>
let subscriptions: Array<{ workspaceId: string; planId: string; status: string }> = []

const store = {
  subscriptionCollection: {
    get all() { return subscriptions },
    loadAll: async () => {},
  },
  usageWalletCollection: { all: [], loadAll: async () => {} },
  usageEventCollection: { all: [], loadPage: async () => {} },
}
const http = {
  get: (url: string) =>
    url.includes('workspace-plan') ? planResponse() : Promise.resolve({}),
}

mock.module('../../domain', () => ({ useSDKDomain: () => store, useSDKHttp: () => http }))

// Import after mocking domain so the hook uses the stubs above.
const { useBillingData } = await import('../useBillingData')
// Import the pub/sub so tests can fire foreground signals directly.
const { registerAppActivitySource } = await import('../../lib/app-activity')

// ---

let latest: ReturnType<typeof useBillingData> | null = null
function Probe({ workspaceId }: { workspaceId: string }) {
  latest = useBillingData(workspaceId)
  return null
}

describe('useBillingData — foreground refetch (SHO-469)', () => {
  let fireForeground: (() => void) | null = null

  beforeEach(() => {
    installHappyDom()
    latest = null
    subscriptions = []
    fireForeground = null
    // Register a controllable source; the returned cleanup tears it down
    // between tests so the module's singleton stays clean.
    registerAppActivitySource((cb) => {
      fireForeground = cb
      return () => { fireForeground = null }
    })
  })
  afterEach(() => cleanup())
  afterAll(() => restoreHappyDom())

  it('500 on mount → foreground fires after 60s → plan resolves → models unlock', async () => {
    // First fetch fails (simulates the outage).
    planResponse = () => Promise.reject(new Error('HTTP 500'))
    render(<Probe workspaceId="ws-grant" />)

    // Wait until the initial (failing) fetch has settled so lastPlanFetchAt is stamped.
    await new Promise<void>((r) => setTimeout(r, 50))

    // Pretend the fix ships: endpoint now returns a grant plan.
    planResponse = () => Promise.resolve({ ok: true, planId: 'enterprise', source: 'grant' })

    // The throttle checks Date.now() - lastPlanFetchAt.current >= 60_000.
    // Advance the clock past the guard by wrapping Date.now.
    const realNow = Date.now.bind(Date)
    const fakeNow = () => realNow() + 65_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Date as any).now = fakeNow
    try {
      act(() => { fireForeground?.() })
      await waitFor(() => expect(latest?.effectivePlanId).toBe('enterprise'), { timeout: 2_000 })
      expect(latest?.hasAdvancedModelAccess).toBe(true)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Date as any).now = realNow
    }
  })

  it('repeated foreground within 60s is throttled (at most one refetch per window)', async () => {
    let fetchCount = 0
    planResponse = () => {
      fetchCount++
      return Promise.resolve({ ok: true, planId: 'enterprise', source: 'grant' })
    }
    render(<Probe workspaceId="ws-throttle" />)
    // Let the initial mount fetch complete.
    await waitFor(() => expect(latest?.effectivePlanId).toBe('enterprise'))
    const countAfterMount = fetchCount

    // Fire foreground multiple times in rapid succession (< 60s — no clock advance).
    act(() => { fireForeground?.() })
    act(() => { fireForeground?.() })
    act(() => { fireForeground?.() })
    // Wait a tick to let any re-renders settle.
    await new Promise<void>((r) => setTimeout(r, 50))

    // Count must not have grown: all three foreground fires are throttled.
    expect(fetchCount).toBe(countAfterMount)
  })

  it('no duplicate subscriptions after multiple component remounts', async () => {
    // Each hook instance registers exactly one subscriber; each unmount removes it.
    // This confirms that the [] deps effect doesn't re-subscribe on re-renders.
    let fetchCount = 0
    planResponse = () => {
      fetchCount++
      return Promise.reject(new Error('skipping'))
    }

    function Probe2({ workspaceId }: { workspaceId: string }) {
      useBillingData(workspaceId)
      return null
    }
    // Mount two independent instances.
    const r1 = render(<Probe2 workspaceId="ws-a" />)
    const r2 = render(<Probe2 workspaceId="ws-b" />)
    await new Promise<void>((res) => setTimeout(res, 50))
    const countAfterMount = fetchCount

    // Advance clock past throttle so both instances would refetch.
    const realNow = Date.now.bind(Date)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Date as any).now = () => realNow() + 65_000
    try {
      act(() => { fireForeground?.() })
      await new Promise<void>((res) => setTimeout(res, 50))
      // Each instance refetches exactly once — no duplicate subscriptions.
      expect(fetchCount - countAfterMount).toBe(2)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Date as any).now = realNow
    }
    r1.unmount()
    r2.unmount()
  })
})
