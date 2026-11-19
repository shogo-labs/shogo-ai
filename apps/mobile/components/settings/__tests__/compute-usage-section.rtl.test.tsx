// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Compute → metered usage (SHO-424).
 *
 * This is what a customer reads instead of the instance-size cards that used to
 * live here, so the two shapes the server can return both have to land:
 *
 *  - an owner/admin gets this period's VM hours and cost split by project,
 *    machine size and state, plus what is running now;
 *  - a member gets the period total only — the split is a spending-visibility
 *    decision the server makes, and the section must not invent one client-side.
 *
 * It also pins the shadow-mode wording ("estimated, not yet charged"), because a
 * number that reads as a charge before enforce is on is the one mistake this
 * panel must not make.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

let payload: any = null
let failure: Error | null = null
const calls: string[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    View: ({ children }: any) => createElement('div', null, children),
    Text: ({ children }: any) => createElement('span', null, children),
    Pressable: ({ children, onPress }: any) => createElement('button', { onClick: onPress }, children),
    ActivityIndicator: () => createElement('i', { 'data-rn': 'spinner' }),
  } as any),
)
mock.module('lucide-react-native', () => ({
  Calculator: () => createElement('i', null),
  Cpu: () => createElement('i', null),
  Clock: () => createElement('i', null),
  Zap: () => createElement('i', null),
}))
mock.module('@shogo/shared-ui/primitives', () => {
  const passthrough = ({ children }: any) => createElement('div', null, children)
  return {
    Card: passthrough,
    CardContent: passthrough,
    Badge: passthrough,
    cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
  }
})
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws_1', name: 'Acme' }),
}))
// One stable client, like the provider's (`ctx.http`): a fresh object per render
// would re-run the component's effect and hide a real re-fetch behind a mock's
// instability.
const HTTP = {}
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => HTTP }))
mock.module('../../../lib/api', () => ({
  api: {
    getWorkspaceComputeUsage: async (_http: any, workspaceId: string) => {
      calls.push(workspaceId)
      if (failure) throw failure
      return payload
    },
  },
}))

const { ComputeUsageSection } = await import('../ComputeUsageSection')

afterEach(() => {
  cleanup()
  calls.length = 0
  failure = null
})

const base = {
  mode: 'shadow',
  currency: 'USD',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-11-18T10:00:00.000Z',
  rates: { vcpuHour: 0.07, gibHour: 0.012, idleBilling: 'none' },
  totals: {
    activeVmHours: 3,
    totalVmHours: 12,
    vcpuHours: 6,
    gibHours: 12,
    estimatedUsd: 0.66,
    notBilledUsd: 1.98,
  },
  daily: [
    { day: '2026-11-17', vmHours: 6, activeVmHours: 1, idleVmHours: 5, estimatedUsd: 0.22 },
    { day: '2026-11-18', vmHours: 6, activeVmHours: 2, idleVmHours: 4, estimatedUsd: 0.44 },
  ],
}

const owner = {
  ...base,
  byProject: [
    { projectId: 'proj_1', name: 'Billing Bot', activeVmHours: 2, idleVmHours: 3, estimatedUsd: 0.44 },
    { projectId: null, name: 'Workspace runtime', activeVmHours: 1, idleVmHours: 6, estimatedUsd: 0.22 },
  ],
  bySize: [{ label: '2 vCPU · 4 GiB', vcpus: 2, memMiB: 4096, activeVmHours: 3, idleVmHours: 9, estimatedUsd: 0.66 }],
  byState: [
    { state: 'active', label: 'Agent + app time', billed: true, vmHours: 3, estimatedUsd: 0.66 },
    { state: 'idle', label: 'Idle tail (not billed)', billed: false, vmHours: 9, estimatedUsd: 1.98 },
  ],
  byCause: [{ cause: 'user_open', vmHours: 12, billed: true, estimatedUsd: 0.66 }],
  runningNow: [{ runtimeKey: 'ws:proj:proj_1', name: 'Billing Bot', memMiB: 4096, runningSinceMs: 4 * 60_000 }],
}

describe('Settings → Compute usage', () => {
  test('an owner sees the period, the split and what is running', async () => {
    payload = owner
    render(createElement(ComputeUsageSection))

    // The period total, the size row and the project row all carry $0.66 — the
    // point is that they agree, not which node came first.
    expect(await screen.findByText(/estimated, not yet charged/)).toBeDefined()
    expect(screen.getAllByText('$0.66').length).toBeGreaterThan(1)
    expect(calls).toEqual(['ws_1'])
    // Shadow wording: an estimate, never "charged".
    expect(screen.getByText(/estimated, not yet charged/)).toBeDefined()
    // The idle tail is metered and labelled as not billed.
    expect(screen.getByText(/Idle tail \(not billed\)/)).toBeDefined()
    expect(screen.getByText('not billed')).toBeDefined()
    // The split is there for an owner.
    expect(screen.getByText('By project')).toBeDefined()
    // Named once in the project split and once under "Running now".
    expect(screen.getAllByText('Billing Bot').length).toBe(2)
    expect(screen.getByText('Workspace runtime')).toBeDefined()
    expect(screen.getByText('By machine size')).toBeDefined()
    expect(screen.getByText('2 vCPU · 4 GiB')).toBeDefined()
    expect(screen.getByText('Running now')).toBeDefined()
    expect(screen.getByText('What started it')).toBeDefined()
    // Rates are stated in full, so the number is checkable. Interpolated text
    // splits across nodes, so read the rendered text rather than one node.
    expect(document.body.textContent).toContain('$0.07/vCPU-hour + $0.012/GiB-hour')
  })

  test('a member gets the total and none of the split', async () => {
    payload = base
    render(createElement(ComputeUsageSection))

    expect(await screen.findByText(/estimated, not yet charged/)).toBeDefined()
    expect(screen.getAllByText('$0.66').length).toBe(1)
    expect(screen.queryByText('By project')).toBeNull()
    expect(screen.queryByText('By machine size')).toBeNull()
    expect(screen.queryByText('Running now')).toBeNull()
    expect(screen.queryByText('What started it')).toBeNull()
    // Broken into states is fine for a member? No — the server decides. The
    // section renders only what it was sent.
    expect(screen.queryByText('Idle tail (not billed)')).toBeNull()
  })

  test('under enforce the same number reads as charged', async () => {
    payload = { ...base, mode: 'enforce' }
    render(createElement(ComputeUsageSection))

    expect(await screen.findByText(/charged to this workspace/)).toBeDefined()
    expect(screen.queryByText(/estimated, not yet charged/)).toBeNull()
  })

  test('a failure shows the server’s own words, not a generic message', async () => {
    failure = new Error('Could not read compute usage')
    render(createElement(ComputeUsageSection))

    expect(await screen.findByText('Compute usage unavailable')).toBeDefined()
    expect(screen.getByText('Could not read compute usage')).toBeDefined()
    // A retry is offered rather than a dead end.
    expect(screen.getByText('Try again')).toBeDefined()
  })
})
