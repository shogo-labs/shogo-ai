// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-510: Settings → Updates could say "vX is available." but offered no way
 * to do anything about it. Download and Restart lived only on the top banner,
 * so dismissing the banner left no route to install that version this session.
 *
 * The actions now come from `lib/use-desktop-update` — the hook the banner uses
 * — and each consumer unsubscribes only its own listener. That second half is
 * the regression these tests pin: the tab used to call `removeUpdateListener()`
 * (an `ipcRenderer.removeAllListeners`) on unmount, which cut the banner's
 * status stream off until the app reloaded.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, testID, ...props }: any) =>
      createElement('button', { ...props, 'data-testid': testID, onClick: onPress }, children),
  }),
)
// Icons pull `react-native-svg`; these tests only need them not to throw.
mock.module('lucide-react-native', () => ({
  RefreshCw: () => null,
  CheckCircle2: () => null,
  AlertCircle: () => null,
  Download: () => null,
  RotateCw: () => null,
  X: () => null,
}))

const passthrough = ({ children }: any) => createElement('div', null, children)
mock.module('@shogo/shared-ui/primitives', () => ({
  Badge: passthrough,
  Card: passthrough,
  CardContent: passthrough,
  Button: ({ children, onPress, testID, disabled }: any) =>
    createElement(
      'button',
      { 'data-testid': testID, onClick: disabled ? undefined : onPress, disabled: !!disabled },
      children,
    ),
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}))
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children),
  useAccountSheetIcons: (icons: Record<string, unknown>) => icons,
}))

const { UpdatesTab } = await import('../UpdatesTab')
const { UpdateBanner } = await import('../../UpdateBanner')

type Counts = { agentRuns: number; backgroundCommands: number }

interface InstallResult {
  ok: boolean
  mode?: 'now' | 'when-idle' | 'immediate'
  needsChoice?: boolean
  message?: string
  activity?: Counts | null
  error?: string
}

interface FakeUpdate {
  status: (payload: {
    status: string
    releaseName?: string | null
    availableVersion?: string | null
    error?: string | null
  }) => void
  drain: (payload: { active: boolean; activity: Counts | null }) => void
  notice: (notice: string | null) => void
  statusListenerCount: () => number
  drainListenerCount: () => number
  noticeListenerCount: () => number
  downloadCalls: () => number
  installCalls: () => Array<{ mode?: 'now' | 'when-idle' } | undefined>
  cancelCalls: () => number
}

function installBridge(options: {
  status?: { status: string; releaseName?: string | null; availableVersion?: string | null; error?: string | null }
  /** Answers in order, one per `installUpdate` call; the last one repeats. */
  installResults?: InstallResult[]
  /** Makes `setUpdateChannel` fail, the way a channel switch does mid-update. */
  channelError?: string
} = {}): FakeUpdate {
  const statusListeners = new Set<(payload: any) => void>()
  const drainListeners = new Set<(payload: any) => void>()
  const noticeListeners = new Set<(payload: any) => void>()
  const installCalls: Array<{ mode?: 'now' | 'when-idle' } | undefined> = []
  const initial = options.status ?? { status: 'idle' }
  const results = options.installResults ?? [{ ok: true, mode: 'immediate' }]
  let downloadCalls = 0
  let cancelCalls = 0

  const bridge = {
    isDesktop: true,
    getSystemInfo: async () => ({ appVersion: '2.6.0' }),
    getUpdateChannel: async () => ({ channel: 'stable' }),
    setUpdateChannel: async (channel: string) =>
      options.channelError ? { ok: false, error: options.channelError } : { ok: true, channel },
    checkForUpdates: async () => ({ ok: true }),
    getUpdateStatus: async () => ({
      status: initial.status,
      releaseName: initial.releaseName ?? null,
      availableVersion: initial.availableVersion ?? null,
      channel: 'stable',
      error: initial.error ?? null,
    }),
    // The preload returns a per-listener unsubscribe (SHO-510); `removeUpdateListener`
    // stays for older callers and clears the whole channel.
    onUpdateStatus: (cb: (payload: any) => void) => {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    removeUpdateListener: () => statusListeners.clear(),
    downloadUpdate: async () => {
      downloadCalls += 1
      return { ok: true }
    },
    dismissUpdate: async () => ({ ok: true }),
    installUpdate: async (call?: { mode?: 'now' | 'when-idle' }) => {
      installCalls.push(call)
      return results[Math.min(installCalls.length - 1, results.length - 1)]
    },
    cancelIdleRestart: async () => {
      cancelCalls += 1
      return { ok: true, cancelled: true }
    },
    onRestartDrain: (cb: (payload: any) => void) => {
      drainListeners.add(cb)
      return () => drainListeners.delete(cb)
    },
    removeRestartDrainListener: () => drainListeners.clear(),
    getInterruptedNotice: async () => ({ notice: null }),
    dismissInterruptedNotice: async () => ({ ok: true }),
    onInterruptedNotice: (cb: (payload: any) => void) => {
      noticeListeners.add(cb)
      return () => noticeListeners.delete(cb)
    },
    removeInterruptedNoticeListener: () => noticeListeners.clear(),
  }

  ;(globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop = bridge

  return {
    status: (payload) =>
      statusListeners.forEach((cb) =>
        cb({
          status: payload.status,
          releaseName: payload.releaseName ?? null,
          availableVersion: payload.availableVersion ?? null,
          channel: 'stable',
          error: payload.error ?? null,
        }),
      ),
    drain: (payload) => drainListeners.forEach((cb) => cb(payload)),
    notice: (notice) => noticeListeners.forEach((cb) => cb({ notice })),
    statusListenerCount: () => statusListeners.size,
    drainListenerCount: () => drainListeners.size,
    noticeListenerCount: () => noticeListeners.size,
    downloadCalls: () => downloadCalls,
    installCalls: () => installCalls,
    cancelCalls: () => cancelCalls,
  }
}

const clearBridge = () => {
  delete (globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop
}

beforeEach(clearBridge)
afterEach(clearBridge)

describe('Settings → Updates actions', () => {
  test('an available update offers Download, and the broadcast moves it to Downloading', async () => {
    const fake = installBridge({ status: { status: 'available', availableVersion: '2.7.0' } })
    render(createElement(UpdatesTab))

    expect(await screen.findByText('2.7.0 is available.')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('shogo-update-download'))
    await waitFor(() => expect(fake.downloadCalls()).toBe(1))

    act(() => fake.status({ status: 'downloading' }))
    await waitFor(() => expect(screen.getByText('Downloading update…')).toBeInTheDocument())
  })

  test('a ready update restarts without asking when nothing is live', async () => {
    const fake = installBridge({
      status: { status: 'ready', releaseName: 'v2.7.0' },
      installResults: [{ ok: true, mode: 'immediate' }],
    })
    render(createElement(UpdatesTab))

    expect(
      await screen.findByText('v2.7.0 is ready to install. Restart to apply it.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('shogo-update-restart'))
    // No mode: the main process is asked first, and restarts because nothing is live.
    await waitFor(() => expect(fake.installCalls()).toEqual([undefined]))
  })

  test('a ready update with live runs asks first, then drains and can be cancelled', async () => {
    const fake = installBridge({
      status: { status: 'ready', releaseName: 'v2.7.0' },
      installResults: [
        {
          ok: false,
          needsChoice: true,
          message: '2 agent runs are working. Restart now, or wait until they finish?',
          activity: { agentRuns: 2, backgroundCommands: 0 },
        },
        { ok: true, mode: 'when-idle', activity: { agentRuns: 2, backgroundCommands: 0 } },
      ],
    })
    render(createElement(UpdatesTab))

    fireEvent.click(await screen.findByTestId('shogo-update-restart'))
    await waitFor(() =>
      expect(screen.getByText(/2 agent runs are working/)).toBeInTheDocument(),
    )
    expect(fake.installCalls()).toEqual([undefined])

    fireEvent.click(screen.getByTestId('shogo-update-restart-when-idle'))
    await waitFor(() => expect(fake.installCalls()[1]).toEqual({ mode: 'when-idle' }))
    await waitFor(() =>
      expect(screen.getByText('Restarting when idle — 2 agent runs working')).toBeInTheDocument(),
    )

    act(() => fake.drain({ active: true, activity: { agentRuns: 1, backgroundCommands: 0 } }))
    await waitFor(() =>
      expect(screen.getByText('Restarting when idle — 1 agent run working')).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByTestId('shogo-update-restart-cancel'))
    await waitFor(() => expect(fake.cancelCalls()).toBe(1))
    await waitFor(() => expect(screen.getByTestId('shogo-update-restart')).toBeInTheDocument())
  })

  test('"Restart now" from the page is the explicit interrupt', async () => {
    const fake = installBridge({
      status: { status: 'ready', releaseName: 'v2.7.0' },
      installResults: [
        { ok: false, needsChoice: true, message: '1 agent run is working.' },
        { ok: true, mode: 'now' },
      ],
    })
    render(createElement(UpdatesTab))

    fireEvent.click(await screen.findByTestId('shogo-update-restart'))
    await waitFor(() => expect(screen.getByTestId('shogo-update-restart-now')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('shogo-update-restart-now'))

    await waitFor(() => expect(fake.installCalls()[1]).toEqual({ mode: 'now' }))
  })

  test('a failed download says why and offers Download again', async () => {
    const fake = installBridge({ status: { status: 'available', availableVersion: '2.7.0' } })
    render(createElement(UpdatesTab))
    await screen.findByTestId('shogo-update-download')

    act(() =>
      fake.status({
        status: 'available',
        availableVersion: '2.7.0',
        error: 'The download did not finish — try again.',
      }),
    )

    await waitFor(() => {
      const box = document.querySelector('[data-rn-shim="shogo-update-error"]')
      expect(box).not.toBeNull()
      expect(box).toHaveTextContent('The download did not finish — try again.')
    })
    expect(screen.getByTestId('shogo-update-download')).toBeInTheDocument()
  })

  // The page's error box holds three kinds of failure; the one the person just
  // caused must win, or a stale channel error reads like the download's reason.
  test('a channel-switch error does not hide why the download failed', async () => {
    const fake = installBridge({
      status: { status: 'available', availableVersion: '2.7.0' },
      channelError: 'Could not switch update channel — try again once the current update finishes.',
    })
    render(createElement(UpdatesTab))
    await screen.findByTestId('shogo-update-download')

    fireEvent.click(screen.getByTestId('shogo-update-channel-beta'))
    await waitFor(() =>
      expect(screen.getByText(/Could not switch update channel/)).toBeInTheDocument(),
    )

    act(() =>
      fake.status({
        status: 'available',
        availableVersion: '2.7.0',
        error: 'The download did not finish — try again.',
      }),
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-rn-shim="shogo-update-error"]'),
      ).toHaveTextContent('The download did not finish — try again.'),
    )
  })

  test('leaving the Updates tab leaves the banner’s listeners alone', async () => {
    const fake = installBridge({ status: { status: 'idle' } })
    render(createElement(UpdateBanner))
    const tab = render(createElement(UpdatesTab))

    // Both surfaces subscribed; the tab owns exactly one of each.
    await waitFor(() => expect(fake.statusListenerCount()).toBe(2))

    tab.unmount()

    await waitFor(() => expect(fake.statusListenerCount()).toBe(1))
    expect(fake.drainListenerCount()).toBe(1)
    expect(fake.noticeListenerCount()).toBe(1)

    // The banner still gets what happens next.
    act(() => fake.status({ status: 'available', availableVersion: '2.7.0' }))
    await waitFor(() => expect(screen.getByText('2.7.0 is available.')).toBeInTheDocument())

    act(() => fake.drain({ active: true, activity: { agentRuns: 2, backgroundCommands: 0 } }))
    await waitFor(() =>
      expect(screen.getByText('Restarting when idle — 2 agent runs working')).toBeInTheDocument(),
    )

    act(() => {
      fake.status({ status: 'idle' })
      fake.notice('Restarting for the update interrupted 2 agent runs; they pick up again automatically.')
    })
    await waitFor(() =>
      expect(screen.getByText(/interrupted 2 agent runs/)).toBeInTheDocument(),
    )
  })
})
