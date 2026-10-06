// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for the `stallThresholdMs` option added to `useAgentUrl` — see
// the "Fix preview-manager race and stall UX" plan. The hook's stall timer
// is a soft UX signal (`stalled: true`) surfaced to a "taking longer than
// expected" recovery card; it must default to the existing 45s constant,
// honor a caller-supplied override, and — critically — never stop the
// underlying `/sandbox/url` poll loop once it fires.
//
// These tests render the hook under happy-dom via @testing-library/react.
// We deliberately avoid waiting out the real 45s default in the "default"
// test (that would make this suite prohibitively slow); instead we assert
// the exact delay passed to `setTimeout` for the stall timer, which is the
// single code path shared with the (fully exercised, short-override) flip
// + continued-polling test below.
import { installHappyDom, restoreHappyDom } from './happy-dom-setup.ts'
import { describe, it, expect, afterAll, afterEach, mock, spyOn } from 'bun:test'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { useAgentUrl } from '../useAgentUrl'

// Another shared-app test file restores the process-wide DOM globals in its
// afterAll hook. Re-install explicitly so this file is order-independent when
// Bun discovers SDKDomainProvider.test.tsx before this one.
installHappyDom()

function notReadyResponse(): Response {
  return new Response(JSON.stringify({ ready: false, status: 'building' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
})

afterAll(() => {
  restoreHappyDom()
})

describe('useAgentUrl — stallThresholdMs', () => {
  it('schedules the stall timer at the default STALL_THRESHOLD_MS (45s) when no override is provided', async () => {
    const fetchMock = mock(async () => notReadyResponse())
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')

    const { unmount } = renderHook(() =>
      useAgentUrl('https://api.test', 'proj-default-threshold', {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    )

    try {
      const stallCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 45_000)
      expect(stallCall).toBeDefined()
    } finally {
      unmount()
      setTimeoutSpy.mockRestore()
    }
  })

  it('schedules the stall timer at a custom stallThresholdMs when provided', async () => {
    const fetchMock = mock(async () => notReadyResponse())
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')

    const { unmount } = renderHook(() =>
      useAgentUrl('https://api.test', 'proj-custom-threshold', {
        fetch: fetchMock as unknown as typeof fetch,
        stallThresholdMs: 150_000,
      }),
    )

    try {
      const stallCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 150_000)
      expect(stallCall).toBeDefined()
      // The default value must NOT also be scheduled — the override fully
      // replaces it rather than layering on top.
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 45_000)).toBe(false)
    } finally {
      unmount()
      setTimeoutSpy.mockRestore()
    }
  })

  it('flips `stalled` to true at a short custom threshold and keeps polling afterward', async () => {
    let calls = 0
    const fetchMock = mock(async () => {
      calls++
      return notReadyResponse()
    })

    const { result, unmount } = renderHook(() =>
      useAgentUrl('https://api.test', 'proj-flip', {
        fetch: fetchMock as unknown as typeof fetch,
        stallThresholdMs: 30,
      }),
    )

    try {
      // Not stalled on the very first render — the timer hasn't fired yet.
      expect(result.current.stalled).toBe(false)

      await waitFor(() => expect(result.current.stalled).toBe(true), { timeout: 2_000 })
      const callsAtStall = calls
      expect(callsAtStall).toBeGreaterThanOrEqual(1)

      // `stalled` is a soft signal only — the poll loop (RETRY_DELAYS_MS,
      // starting at 750ms) must keep running past it. Without this, the
      // "never loads" UX bug would be worse: not only would the recovery
      // card show early, polling would silently stop too.
      await waitFor(() => expect(calls).toBeGreaterThan(callsAtStall), { timeout: 3_000 })
    } finally {
      unmount()
    }
  })
})

describe('useAgentUrl — workspace compute budget', () => {
  const budgetMessage = {
    message: 'Opening this project put 1 other project to sleep (Odin A).',
    instanceSize: 'large',
    instanceLabel: 'Large',
    budgetGb: 16,
    runningCount: 1,
    projects: [{ id: 'a', name: 'Odin A' }],
    canUpgrade: true,
  }

  it('surfaces the notice when opening put other projects to sleep, until dismissed', async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ ready: true, agentUrl: 'https://agent.test', budgetNotice: budgetMessage }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const { result, unmount } = renderHook(() =>
      useAgentUrl('https://api.test', 'proj-budget-notice', { fetch: fetchMock as unknown as typeof fetch }),
    )
    try {
      await waitFor(() => expect(result.current.budgetNotice).toEqual(budgetMessage))
      expect(result.current.ready).toBe(true)
      result.current.dismissBudgetNotice()
      await waitFor(() => expect(result.current.budgetNotice).toBeNull())
    } finally {
      unmount()
    }
  })

  it('reports a refused open with its message and capacity details', async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ error: 'workspace_capacity', message: 'All of it is in use.', capacity: budgetMessage }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    )
    const { result, unmount } = renderHook(() =>
      useAgentUrl('https://api.test', 'proj-budget-refused', { fetch: fetchMock as unknown as typeof fetch }),
    )
    try {
      await waitFor(() => expect(result.current.lastStatus).toBe('workspace_capacity'))
      expect(result.current.error).toBe('All of it is in use.')
      expect(result.current.capacity).toEqual(budgetMessage)
      expect(result.current.ready).toBe(false)
    } finally {
      unmount()
    }
  })
})
