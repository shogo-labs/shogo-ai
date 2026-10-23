// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The banner a machine workspace shows, in each of its three states
 * (SHO-185, AC4): asleep, waking, and fine.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { machineWorkspaceState } from '@shogo/shared-app/services'

mock.module('react-native', () => ({
  ...createReactNativeMock(),
  Platform: { OS: 'web', select: (spec: any) => spec.web ?? spec.default },
  // The base shim forwards `onPress` as-is, which a DOM click never calls; the
  // button in the banner is the one thing here that has to be pressable.
  Pressable: ({ onPress, children, accessibilityLabel, ...rest }: any) =>
    createElement('button', { ...rest, 'aria-label': accessibilityLabel, onClick: onPress }, children),
}))

mock.module('lucide-react-native', () => {
  const Icon = (props: any) => createElement('span', { 'data-icon': props.size })
  return { CloudOff: Icon, RefreshCw: Icon, Cloud: Icon }
})

const { MachineWorkspaceBanner, useMachineWorkspace } = await import('../MachineWorkspaceBanner')

/**
 * The RN shim renders `testID` as `data-rn-shim` (nothing else maps it), so the
 * banner is found that way rather than through RTL's `getByTestId`.
 */
const banner = () => document.querySelector('[data-rn-shim="machine-workspace-banner"]')

function Harness({
  machineName,
  lastSyncedAt,
  onRetry,
  onState,
}: {
  machineName?: string
  lastSyncedAt?: string | null
  onRetry?: () => void | Promise<void>
  onState?: (view: { composeDisabled: boolean; tone: string }) => void
}) {
  const view = useMachineWorkspace({ machineName, lastSyncedAt, onRetry })
  onState?.({ composeDisabled: view.composeDisabled, tone: view.tone })
  return createElement(MachineWorkspaceBanner, { machineName, lastSyncedAt, onRetry })
}

beforeEach(() => {
  machineWorkspaceState.reset()
})

describe('a machine workspace whose Mac is asleep', () => {
  test('shows the machine by name with when it last synced, and refuses writes', () => {
    const seen: { composeDisabled: boolean; tone: string }[] = []
    machineWorkspaceState.report({ status: 409, code: 'machine_offline_readonly' })

    render(
      createElement(Harness, {
        machineName: "Russell's MacBook",
        lastSyncedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        onState: (view) => seen.push(view),
      }),
    )

    expect(banner()).not.toBeNull()
    expect(screen.getByText(/is offline — last synced 12m ago/)).toBeTruthy()
    expect(screen.getByText(/Russell's MacBook/)).toBeTruthy()
    // The composer is disabled from the same value the banner renders.
    expect(seen.at(-1)).toEqual({ composeDisabled: true, tone: 'offline' })
  })

  test('offers Try again, and calls it', async () => {
    let retried = 0
    machineWorkspaceState.report({ status: 409, code: 'machine_offline_readonly' })

    render(createElement(Harness, { machineName: 'Mac', onRetry: () => { retried++ } }))
    fireEvent.click(screen.getByText('Try again'))

    await waitFor(() => expect(retried).toBe(1))
  })
})

describe('a machine that is coming up', () => {
  test('says Waking, keeps the composer disabled, and retries once the wait is over', async () => {
    const seen: { composeDisabled: boolean; tone: string }[] = []
    let retried = 0
    machineWorkspaceState.report({
      status: 503,
      code: 'waking',
      headers: { get: (name: string) => (name === 'retry-after' ? '0.05' : null) },
    })

    render(
      createElement(Harness, {
        machineName: "Russell's MacBook",
        onRetry: () => { retried++ },
        onState: (view) => seen.push(view),
      }),
    )

    expect(screen.getByText("Waking Russell's MacBook…")).toBeTruthy()
    expect(seen.at(-1)).toEqual({ composeDisabled: true, tone: 'waking' })
    // A waking machine retries itself — no button, no tap.
    expect(screen.queryByText('Try again')).toBeNull()

    await waitFor(() => expect(retried).toBeGreaterThanOrEqual(1))
  })
})

describe('a machine that answered', () => {
  test('renders nothing at all, and leaves the composer alone', () => {
    const seen: { composeDisabled: boolean; tone: string }[] = []

    const view = render(createElement(Harness, { machineName: 'Mac', onState: (v) => seen.push(v) }))

    expect(banner()).toBeNull()
    expect(view.container.textContent ?? '').toBe('')
    expect(seen.at(-1)).toEqual({ composeDisabled: false, tone: 'none' })
  })

  test('clears the banner the moment a request comes back', async () => {
    machineWorkspaceState.report({ status: 409, code: 'machine_offline_readonly' })
    render(createElement(Harness, { machineName: 'Mac' }))
    expect(banner()).not.toBeNull()

    machineWorkspaceState.markOk()

    await waitFor(() => expect(banner()).toBeNull())
  })
})
