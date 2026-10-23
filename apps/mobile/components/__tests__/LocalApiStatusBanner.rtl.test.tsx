// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-60: the desktop API supervisor now recovers a *wedged* API (alive, not
 * serving) and gives up loudly after five attempts. The renderer's only surface
 * for that is this banner, and it lives on the desktop bridge — which a real
 * Electron run is the only other way to reach. These tests drive the three
 * states and the Retry / Open log buttons through a fake `window.shogoDesktop`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  }),
)
// The icons pull `react-native-svg`; the banner only needs them to not throw.
mock.module('lucide-react-native', () => ({
  X: () => null,
  RotateCw: () => null,
  FileText: () => null,
}))

const { LocalApiStatusBanner, LOCAL_API_BANNER_REVEAL_MS } = await import(
  '../LocalApiStatusBanner'
)

type RestartingInfo = { attempt: number; maxAttempts: number; delayMs: number }
type RestartedInfo = { attempt: number; pid?: number }
type UnavailableInfo = { error: string }

interface FakeBridge {
  bridge: Record<string, unknown>
  emitRestarting: (info?: Partial<RestartingInfo>) => void
  emitRestarted: (info?: Partial<RestartedInfo>) => void
  emitUnavailable: (info: UnavailableInfo) => void
  restartCalls: () => number
  openLogCalls: () => number
}

function installBridge(options: {
  restartResult?: { ok: boolean; pid?: number; error?: string }
  openLogResult?: { ok: boolean; path?: string; error?: string }
} = {}): FakeBridge {
  const starting = new Set<(info: RestartingInfo) => void>()
  const restarted = new Set<(info: RestartedInfo) => void>()
  const unavailable = new Set<(info: UnavailableInfo) => void>()
  let restartCalls = 0
  let openLogCalls = 0

  const bridge = {
    onLocalServerRestarting: (cb: (info: RestartingInfo) => void) => {
      starting.add(cb)
      return () => starting.delete(cb)
    },
    onLocalServerRestarted: (cb: (info: RestartedInfo) => void) => {
      restarted.add(cb)
      return () => restarted.delete(cb)
    },
    onLocalServerUnavailable: (cb: (info: UnavailableInfo) => void) => {
      unavailable.add(cb)
      return () => unavailable.delete(cb)
    },
    restartLocalServer: async () => {
      restartCalls += 1
      return options.restartResult ?? { ok: true, pid: 4242 }
    },
    openLocalServerLog: async () => {
      openLogCalls += 1
      return options.openLogResult ?? { ok: true, path: '/logs/api-supervisor.log' }
    },
  }

  ;(globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop = bridge

  return {
    bridge,
    emitRestarting: (info = {}) =>
      [...starting].forEach((cb) =>
        cb({ attempt: 1, maxAttempts: 5, delayMs: 500, ...info }),
      ),
    emitRestarted: (info = {}) => [...restarted].forEach((cb) => cb(info)),
    emitUnavailable: (info) => [...unavailable].forEach((cb) => cb(info)),
    restartCalls: () => restartCalls,
    openLogCalls: () => openLogCalls,
  }
}

// The RN mock renders `testID` as `data-rn-shim`, not `data-testid`.
const banner = () =>
  document.querySelector('[data-rn-shim="shogo-local-api-banner"]')

beforeEach(() => {
  delete (globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop
})

afterEach(() => {
  delete (globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop
})

describe('LocalApiStatusBanner', () => {
  test('a restart that beats the reveal delay never paints (no flash)', async () => {
    const fake = installBridge()
    render(createElement(LocalApiStatusBanner))

    act(() => fake.emitRestarting())
    // The SHO-26 respawn is ~200-440 ms; the banner waits 2 s before showing.
    await new Promise((resolve) => setTimeout(resolve, 100))
    act(() => fake.emitRestarted({ attempt: 1, pid: 1234 }))

    expect(banner()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, LOCAL_API_BANNER_REVEAL_MS + 200))
    expect(banner()).toBeNull()
  }, 15_000)

  test('a slow restart shows the attempt number and clears when it lands', async () => {
    const fake = installBridge()
    render(createElement(LocalApiStatusBanner))

    act(() => fake.emitRestarting({ attempt: 2, maxAttempts: 5 }))
    // Hidden during the grace window, then visible.
    expect(banner()).toBeNull()
    await waitFor(() => expect(banner()).not.toBeNull(), { timeout: LOCAL_API_BANNER_REVEAL_MS + 1_500 })
    expect(screen.getByText(/Local API restarting \(attempt 2\/5\)/)).toBeInTheDocument()

    act(() => fake.emitRestarted({ attempt: 2, pid: 4242 }))
    await waitFor(() => expect(banner()).toBeNull())
  }, 15_000)

  test('unavailable shows at once with Retry and Open log', async () => {
    const fake = installBridge()
    render(createElement(LocalApiStatusBanner))

    act(() =>
      fake.emitUnavailable({
        error: 'The local API server exited unexpectedly and 5 restart attempts failed.',
      }),
    )

    // No reveal delay on the terminal state.
    expect(banner()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open log' })).toBeInTheDocument()
    expect(screen.getByText(/5 restart attempts failed/)).toBeInTheDocument()
  })

  test('Retry starts a fresh child and the banner clears on restarted', async () => {
    const fake = installBridge()
    render(createElement(LocalApiStatusBanner))
    act(() => fake.emitUnavailable({ error: 'gave up' }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fake.restartCalls()).toBe(1))

    // The success path comes back as restarting → restarted.
    act(() => fake.emitRestarting({ attempt: 1 }))
    act(() => fake.emitRestarted({ attempt: 1, pid: 999 }))
    await waitFor(() => expect(banner()).toBeNull())
  }, 15_000)

  test('a Retry that fails keeps the banner up and shows why', async () => {
    const fake = installBridge({
      restartResult: { ok: false, error: 'EADDRINUSE: the old API child still holds port 39100' },
    })
    render(createElement(LocalApiStatusBanner))
    act(() => fake.emitUnavailable({ error: 'gave up' }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() =>
      expect(screen.getByText(/EADDRINUSE: the old API child still holds port 39100/)).toBeInTheDocument(),
    )
    expect(banner()).not.toBeNull()
    expect(fake.restartCalls()).toBe(1)
  })

  test('Open log reports the failure instead of looking like a no-op', async () => {
    const fake = installBridge({
      openLogResult: {
        ok: false,
        path: '/Users/x/Library/Application Support/Shogo/logs/api-supervisor.log',
        error: 'No API supervisor log at /Users/x/Library/Application Support/Shogo/logs/api-supervisor.log',
      },
    })
    render(createElement(LocalApiStatusBanner))
    act(() => fake.emitUnavailable({ error: 'gave up' }))

    fireEvent.click(screen.getByRole('button', { name: 'Open log' }))

    await waitFor(() => expect(screen.getByText(/No API supervisor log at/)).toBeInTheDocument())
    expect(fake.openLogCalls()).toBe(1)
  })
})
