// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-181: the update banner's Restart is no longer a silent kill.
 *
 * The bug: clicking Restart called `quitAndInstall()` at once, so every live
 * agent run died with no warning and no alternative — and the same for Quit.
 * The main process now answers "are runs live?" first (`install-update` with no
 * mode returns `needsChoice`), "Restart when idle" drains and waits, and the
 * next boot says what the last restart interrupted.
 *
 * That contract lives on the desktop bridge, which only a real Electron run can
 * reach otherwise — these tests drive the banner through a fake
 * `window.shogoDesktop`, so what is asserted is the *shape* the main process
 * sees (which mode was sent) and what the person is shown (the choice, the
 * live count while draining, the one-line notice).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, testID, ...props }: any) =>
      createElement('button', { ...props, 'data-testid': testID, onClick: onPress }, children),
  }),
)
// The icons pull `react-native-svg`; the banner only needs them to not throw.
mock.module('lucide-react-native', () => ({ X: () => null }))

const { UpdateBanner } = await import('../UpdateBanner')

type Counts = { liveTurns: number; runningTasks: number; runningAgentReplies: number }

interface InstallResult {
  ok: boolean
  mode?: 'now' | 'when-idle' | 'immediate'
  needsChoice?: boolean
  message?: string
  activity?: Counts | null
  error?: string
}

interface FakeDesktop {
  bridge: Record<string, unknown>
  status: (payload: { status: string; releaseName?: string | null; availableVersion?: string | null }) => void
  drain: (payload: { active: boolean; activity: Counts | null }) => void
  installCalls: () => Array<{ mode?: 'now' | 'when-idle' } | undefined>
  cancelCalls: () => number
  dismissNoticeCalls: () => number
}

function installBridge(options: {
  status?: { status: string; releaseName?: string | null; availableVersion?: string | null }
  notice?: string | null
  /** Answers in order, one per `installUpdate` call; the last one repeats. */
  installResults?: InstallResult[]
} = {}): FakeDesktop {
  const statusListeners = new Set<(payload: any) => void>()
  const drainListeners = new Set<(payload: any) => void>()
  const noticeListeners = new Set<(payload: any) => void>()
  const installCalls: Array<{ mode?: 'now' | 'when-idle' } | undefined> = []
  let cancelCalls = 0
  let dismissNoticeCalls = 0

  const results = options.installResults ?? [{ ok: true, mode: 'immediate' }]
  const initialStatus = options.status ?? { status: 'ready', releaseName: 'v2.3.12', availableVersion: '2.3.12' }

  const bridge = {
    isDesktop: true,
    getUpdateStatus: async () => ({
      status: initialStatus.status,
      releaseName: initialStatus.releaseName ?? null,
      availableVersion: initialStatus.availableVersion ?? null,
      channel: 'stable',
    }),
    onUpdateStatus: (cb: (payload: any) => void) => {
      statusListeners.add(cb)
    },
    removeUpdateListener: () => statusListeners.clear(),
    downloadUpdate: async () => ({ ok: true }),
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
    },
    removeRestartDrainListener: () => drainListeners.clear(),
    getInterruptedNotice: async () => ({ notice: options.notice ?? null }),
    dismissInterruptedNotice: async () => {
      dismissNoticeCalls += 1
      return { ok: true }
    },
    onInterruptedNotice: (cb: (payload: any) => void) => {
      noticeListeners.add(cb)
    },
    removeInterruptedNoticeListener: () => noticeListeners.clear(),
  }

  ;(globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop = bridge

  return {
    bridge,
    status: (payload) =>
      statusListeners.forEach((cb) =>
        cb({
          status: payload.status,
          releaseName: payload.releaseName ?? null,
          availableVersion: payload.availableVersion ?? null,
          channel: 'stable',
        }),
      ),
    drain: (payload) => drainListeners.forEach((cb) => cb(payload)),
    installCalls: () => installCalls,
    cancelCalls: () => cancelCalls,
    dismissNoticeCalls: () => dismissNoticeCalls,
  }
}

/** The RN mock renders `testID` as `data-rn-shim` for View/Text hosts. */
const banner = (testID: string) => document.querySelector(`[data-rn-shim="${testID}"]`)

const clearBridge = () => {
  delete (globalThis as unknown as { window: { shogoDesktop?: unknown } }).window.shogoDesktop
}

beforeEach(clearBridge)
afterEach(clearBridge)

describe('UpdateBanner restart gate', () => {
  test('Restart with live work asks first and never restarts on its own', async () => {
    const fake = installBridge({
      installResults: [
        {
          ok: false,
          needsChoice: true,
          message: '3 agent runs are working. Restart now, or wait until they finish?',
          activity: { liveTurns: 2, runningTasks: 1, runningAgentReplies: 0 },
        },
      ],
    })
    render(createElement(UpdateBanner))

    const restart = await screen.findByRole('button', { name: 'Restart' })
    fireEvent.click(restart)

    await waitFor(() => expect(banner('shogo-update-banner-choice')).not.toBeNull())
    // The probe is the *only* call: no mode was sent, so nothing quit.
    expect(fake.installCalls()).toEqual([undefined])
    expect(screen.getByText(/3 agent runs are working/)).toBeInTheDocument()
    expect(screen.getByTestId('update-restart-when-idle')).toBeInTheDocument()
    expect(screen.getByTestId('update-restart-now')).toBeInTheDocument()
  })

  test('"Restart when idle" sends the mode and shows what it is waiting for', async () => {
    const fake = installBridge({
      installResults: [
        { ok: false, needsChoice: true, message: '2 agent runs are working.' },
        {
          ok: true,
          mode: 'when-idle',
          activity: { liveTurns: 2, runningTasks: 1, runningAgentReplies: 0 },
        },
      ],
    })
    render(createElement(UpdateBanner))

    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(screen.getByTestId('update-restart-when-idle')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('update-restart-when-idle'))

    await waitFor(() => expect(banner('shogo-update-banner-draining')).not.toBeNull())
    expect(fake.installCalls()[1]).toEqual({ mode: 'when-idle' })
    expect(screen.getByText('Restarting when idle — 3 agent runs working')).toBeInTheDocument()

    // The drain's own polls move the count down, and say so honestly.
    act(() => fake.drain({ active: true, activity: { liveTurns: 1, runningTasks: 0, runningAgentReplies: 0 } }))
    await waitFor(() =>
      expect(screen.getByText('Restarting when idle — 1 agent run working')).toBeInTheDocument(),
    )
    act(() => fake.drain({ active: true, activity: { liveTurns: 0, runningTasks: 0, runningAgentReplies: 0 } }))
    await waitFor(() =>
      expect(screen.getByText(/waiting for the last run to finish/)).toBeInTheDocument(),
    )
  })

  test('Cancel lifts the drain and puts the restart back behind the button', async () => {
    const fake = installBridge({
      installResults: [
        { ok: false, needsChoice: true, message: '1 agent run is working.' },
        { ok: true, mode: 'when-idle', activity: { liveTurns: 1, runningTasks: 0, runningAgentReplies: 0 } },
      ],
    })
    render(createElement(UpdateBanner))

    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(screen.getByTestId('update-restart-when-idle')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('update-restart-when-idle'))
    await waitFor(() => expect(banner('shogo-update-banner-draining')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(fake.cancelCalls()).toBe(1))
    expect(banner('shogo-update-banner-draining')).toBeNull()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
  })

  test('"Restart now" is the explicit interrupt', async () => {
    const fake = installBridge({
      installResults: [
        { ok: false, needsChoice: true, message: '2 agent runs are working.' },
        { ok: true, mode: 'now' },
      ],
    })
    render(createElement(UpdateBanner))

    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(screen.getByTestId('update-restart-now')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('update-restart-now'))

    await waitFor(() => expect(fake.installCalls()[1]).toEqual({ mode: 'now' }))
    expect(banner('shogo-update-banner-draining')).toBeNull()
  })

  test('with nothing live the button does not ask', async () => {
    const fake = installBridge({ installResults: [{ ok: true, mode: 'immediate' }] })
    render(createElement(UpdateBanner))

    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))

    await waitFor(() => expect(fake.installCalls()).toHaveLength(1))
    expect(banner('shogo-update-banner-choice')).toBeNull()
  })

  test('a "when idle" that could not start says why instead of looking like a no-op', async () => {
    installBridge({
      installResults: [
        { ok: false, needsChoice: true, message: '1 agent run is working.' },
        { ok: false, error: 'The API could not be reached — try again.' },
      ],
    })
    render(createElement(UpdateBanner))

    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(screen.getByTestId('update-restart-when-idle')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('update-restart-when-idle'))

    await waitFor(() =>
      expect(screen.getByText('The API could not be reached — try again.')).toBeInTheDocument(),
    )
  })

  test('the last restart says once what it interrupted, and can be dismissed', async () => {
    const fake = installBridge({
      status: { status: 'idle' },
      notice: 'Restarting for the update interrupted 3 agent runs; they pick up again automatically.',
    })
    render(createElement(UpdateBanner))

    await waitFor(() => expect(banner('shogo-interrupted-notice')).not.toBeNull())
    expect(
      screen.getByText('Restarting for the update interrupted 3 agent runs; they pick up again automatically.'),
    ).toBeInTheDocument()

    const dismiss = banner('shogo-interrupted-notice')?.querySelector('button')
    expect(dismiss).not.toBeNull()
    fireEvent.click(dismiss as Element)

    await waitFor(() => expect(fake.dismissNoticeCalls()).toBe(1))
    expect(banner('shogo-interrupted-notice')).toBeNull()
  })
})
