// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → Analytics → Compute panel (SHO-424).
 *
 * The panel is rendered on the super-admin analytics page, so a crash here takes
 * that page down. Two shapes matter:
 *  - the response the API actually serializes must render (a field the panel
 *    needs but the route does not send is a TypeError, not an empty state);
 *  - a fleet with no metered hours yet must still render the coverage line,
 *    because that is the state on the first day and the one an operator reads
 *    to find out whether the meter is working at all.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

let nextPayload: any = null
let lastPath = ''

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    View: ({ children }: any) => createElement('div', null, children),
    Text: ({ children }: any) => createElement('span', null, children),
    numberOfLines: undefined,
  } as any),
)
mock.module('lucide-react-native', () => ({
  Cpu: () => createElement('i', { 'data-icon': 'cpu' }),
  Server: () => createElement('i', { 'data-icon': 'server' }),
  AlertTriangle: () => createElement('i', { 'data-icon': 'alert' }),
}))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
}))
mock.module('../../../app/(admin)/_analytics-shared', () => ({
  fetchAdminJson: async (path: string) => {
    lastPath = path
    return nextPayload
  },
}))

const { ComputePanel } = await import('../ComputePanel')

afterEach(() => cleanup())

function summary(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'shadow',
    windowStart: '2026-11-01T00:00:00.000Z',
    generatedAt: '2026-11-18T10:00:00.000Z',
    rates: { vcpuHour: 0.07, gibHour: 0.012, idleBilling: 'none' },
    fleet: {
      hosts: 5,
      hostMonthlyUsd: 500,
      hostCostUsd: 2500,
      marginUsd: 1000,
      assignedNow: 22,
      livenessNow: { appActive: 1, agentActive: 6, idleTail: 15 },
    },
    totals: {
      vmHours: 16000,
      activeVmHours: 2720,
      idleVmHours: 13280,
      billableUsd: 3500,
      platformOverheadUsd: 2000,
      stampedUsd: 3500,
      stampedRows: 4000,
    },
    byCause: [{ cause: 'user_open', vmHours: 9000, estimatedUsd: 3500, notBilledUsd: 1500 }],
    topWorkspaces: [
      { workspaceId: 'ws_1', name: 'Odin AI', vmHours: 4000, activeVmHours: 700, estimatedUsd: 900, notBilledUsd: 400 },
    ],
    reconciliation: { hostsReportingUsage: 5, hostsMissingMeter: [] },
    ...overrides,
  }
}

describe('admin Compute panel', () => {
  test('renders the fleet numbers and the coverage line', async () => {
    nextPayload = summary()
    render(createElement(ComputePanel))

    expect(await screen.findByText(/SHADOW — not charged/)).toBeDefined()
    expect(screen.getByText('Odin AI')).toBeDefined()
    expect(screen.getByText(/Meter coverage/)).toBeDefined()
    expect(screen.getByText(/5 host\(s\) reported usage in the last 72h/)).toBeDefined()
    // The rate card is stated in full so an operator can check the number. The
    // 3-decimal memory rate is the one that would silently round wrong.
    expect(document.body.textContent).toContain('$0.07/vCPU-h + $0.012/GiB-h')
    expect(lastPath).toBe('/compute')
  })

  test('names the hosts that run VMs without reporting a meter', async () => {
    nextPayload = summary({ reconciliation: { hostsReportingUsage: 3, hostsMissingMeter: ['metal-us-9'] } })
    render(createElement(ComputePanel))

    expect(await screen.findByText(/metal-us-9/)).toBeDefined()
  })

  // Kept last: the crash below leaves React poisoned for later renders in the
  // same file ("Should not already be working"), which would mask real failures.
  test('survives a response whose reconciliation block is missing', async () => {
    // `adminComputeSummary()` builds the block with an un-awaited promise, so on
    // the wire it is `{}` — this is the shape the panel actually receives.
    nextPayload = summary({ reconciliation: {} })
    render(createElement(ComputePanel))

    // The panel must still render: an undefined list is a crash on the page,
    // not an empty state.
    expect(await screen.findByText(/Meter coverage/)).toBeDefined()
    expect(screen.getByText('Odin AI')).toBeDefined()
  })
})
