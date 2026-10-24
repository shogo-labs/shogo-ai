// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const push = mock((_args: any) => {})
mock.module('expo-router', () => ({ useRouter: () => ({ push }) }))

const http = { id: 'http', patch: mock(async (..._args: any[]): Promise<any> => ({})) }
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => http }))

const getWorkspaceAnalytics = mock(async (..._args: any[]): Promise<any> => ({}))
mock.module('../../../lib/api', () => ({ api: { getWorkspaceAnalytics } }))

mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws_1', name: 'Acme' }),
}))
mock.module('../../../lib/native-active-shadow', () => ({
  nativeActivePill: () => ({ className: '', style: undefined }),
}))
mock.module('../../settings/account-sheet-chrome', () => ({
  Text: ({ children, ...props }: any) => createElement('span', props, children),
  accountSheetIcon: (icon: any) => icon,
}))
// The real module pulls the model catalog and the density context; the panel
// only needs these three.
mock.module('../SharedAnalytics', () => ({
  StatCard: ({ label, value, subtitle }: any) =>
    createElement('div', { 'data-testid': `stat-${label}` }, [
      createElement('span', { key: 'v', 'data-testid': `value-${label}` }, String(value)),
      subtitle ? createElement('span', { key: 's' }, subtitle) : null,
    ]),
  formatDollarCost: (n: number | null | undefined) =>
    n == null ? '—' : `$${Number(n).toFixed(2)}`,
  getModelDisplayName: (id: string) => id.replace(/^claude-/, 'Claude '),
}))
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ isOpen, children }: any) => (isOpen ? createElement('div', null, children) : null),
  AlertDialogBackdrop: () => null,
  AlertDialogContent: ({ children, ...props }: any) => createElement('div', props, children),
  AlertDialogHeader: ({ children }: any) => createElement('div', null, children),
  AlertDialogBody: ({ children }: any) => createElement('div', null, children),
  AlertDialogFooter: ({ children }: any) => createElement('div', null, children),
}))
mock.module('@/components/ui/heading', () => ({
  Heading: ({ children }: any) => createElement('div', null, children),
}))
mock.module('@/components/ui/text', () => ({
  Text: ({ children }: any) => createElement('div', null, children),
}))
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onPress, accessibilityLabel }: any) =>
    createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children),
  ButtonText: ({ children }: any) => createElement('div', null, children),
}))

const {
  WorkspaceHeartbeatsPanel,
  formatInterval,
  formatShareOfSpend,
  modelMismatch,
  relativeTick,
  sortHeartbeatRows,
} = await import('../WorkspaceHeartbeatsPanel')

/**
 * `testID` reaches the DOM as the `testid` attribute — React lowercases unknown
 * props on host elements, and the shared react-native mock only adds
 * `data-rn-shim`, so `getByTestId` (which looks for `data-testid`) misses it.
 */
const rnTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[testid="${id}"]`) as HTMLElement | null
const byTestId = (id: string): HTMLElement => {
  const el = rnTestId(id)
  if (!el) throw new Error(`no element with testID="${id}"`)
  return el
}

const agent = (over: Record<string, any> = {}) => ({
  projectId: 'proj_1',
  projectName: 'Support triage',
  owner: { userId: 'user_1', name: 'Ada', email: 'ada@example.com' },
  enabled: true,
  intervalSeconds: 1800,
  quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
  lastHeartbeatAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  nextHeartbeatAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  configuredModel: 'claude-sonnet-4',
  configuredModelLabel: 'claude-sonnet-4',
  modelsUsed: [{ model: 'claude-sonnet-4', billedUsd: 0.9 }],
  ticks: 40,
  billedUsd: 0.9,
  rawUsd: 1.5,
  totalTokens: 120_000,
  avgUsdPerTick: 0.0225,
  canEdit: true,
  ...over,
})

const report = (over: Record<string, any> = {}) => ({
  period: '24h',
  window: { from: '2026-10-23T00:00:00.000Z', to: '2026-10-24T00:00:00.000Z' },
  totals: {
    agentsEnabled: 2,
    agentsWithSpend: 2,
    ticks: 48,
    billedUsd: 1.1,
    rawUsd: 1.7,
    totalTokens: 140_000,
    workspaceBilledUsd: 4.4,
  },
  daily: [
    { date: '2026-10-23', heartbeatUsd: 0.6, otherUsd: 1.4 },
    { date: '2026-10-24', heartbeatUsd: 0.5, otherUsd: 1.9 },
  ],
  agents: [
    agent(),
    agent({
      projectId: 'proj_2',
      projectName: 'Nightly digest',
      owner: { userId: 'user_2', name: null, email: 'bo@example.com' },
      enabled: false,
      intervalSeconds: 86_400,
      quietHours: null,
      nextHeartbeatAt: null,
      ticks: 8,
      billedUsd: 0.2,
      avgUsdPerTick: 0.025,
      canEdit: false,
    }),
  ],
  ...over,
})

beforeEach(() => {
  getWorkspaceAnalytics.mockReset()
  getWorkspaceAnalytics.mockImplementation(async () => report())
  http.patch.mockReset()
  http.patch.mockImplementation(async () => ({}))
  push.mockReset()
})

afterEach(() => cleanup())

describe('WorkspaceHeartbeatsPanel', () => {
  test('asks for heartbeat spend for the active workspace and 24h by default', async () => {
    render(<WorkspaceHeartbeatsPanel />)

    expect(await screen.findByText('Support triage')).toBeTruthy()
    expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1)
    const [passedHttp, workspaceId, endpoint, params] = getWorkspaceAnalytics.mock.calls[0]
    expect(passedHttp).toBe(http)
    expect(workspaceId).toBe('ws_1')
    expect(endpoint).toBe('heartbeats')
    expect(params).toEqual({ period: '24h' })
  })

  test('renders the schedule, the cost and the share of workspace spend', async () => {
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Support triage')

    expect(screen.getByText('Nightly digest')).toBeTruthy()
    // Schedule, in human units rather than seconds.
    expect(screen.getByText('every 30 min')).toBeTruthy()
    expect(screen.getByText('every 1d')).toBeTruthy()
    expect(screen.getByText('22:00–07:00')).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
    // Model, ticks and money.
    expect(screen.getAllByText('Claude sonnet-4').length).toBeGreaterThan(0)
    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByText('$0.90')).toBeTruthy()
    expect(screen.getByText('$0.02')).toBeTruthy()
    // Totals row and the card the whole tab exists for.
    expect(screen.getByText('Workspace total (2 on)')).toBeTruthy()
    // Totals row and the "Heartbeat spend" card, on purpose.
    expect(screen.getAllByText('$1.10').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('value-Share of spend').textContent).toBe('25%')
    expect(screen.getByTestId('value-Agents on').textContent).toBe('2')
    expect(screen.getByText('On')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
    // Daily split, so the heartbeat line is comparable to everything else.
    expect(rnTestId('heartbeat-daily-split')).toBeTruthy()
  })

  test('switching the period refetches with that window', async () => {
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Support triage')

    fireEvent.click(byTestId('heartbeat-period-30d'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    expect(getWorkspaceAnalytics.mock.calls[1][3]).toEqual({ period: '30d' })
  })

  test('an empty report shows the empty state instead of a table', async () => {
    getWorkspaceAnalytics.mockImplementation(async () =>
      report({
        agents: [],
        totals: { agentsEnabled: 0, agentsWithSpend: 0, ticks: 0, billedUsd: 0, rawUsd: 0, totalTokens: 0, workspaceBilledUsd: 0 },
        daily: [],
      }),
    )
    render(<WorkspaceHeartbeatsPanel />)

    expect(await screen.findByText('No agents have heartbeats on')).toBeTruthy()
    expect(screen.queryByText('Agent')).toBeNull()
  })

  test('a 403 explains the gate instead of showing an error', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => {
      throw Object.assign(new Error('Advanced workspace analytics require a Business plan or higher.'), { status: 403 })
    })
    render(<WorkspaceHeartbeatsPanel />)

    expect(await screen.findByText('Heartbeat spend')).toBeTruthy()
    expect(screen.getByText(/Business plan or higher/)).toBeTruthy()
    expect(screen.queryByText('Agent')).toBeNull()
  })

  test('other failures surface the server message', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => {
      throw new Error('analytics_failed: boom')
    })
    render(<WorkspaceHeartbeatsPanel />)

    expect(await screen.findByText('analytics_failed: boom')).toBeTruthy()
  })

  test('turning one off confirms first, then PATCHes the existing heartbeat config', async () => {
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Support triage')

    fireEvent.click(byTestId('heartbeat-turn-off-proj_1'))

    // The confirmation names the money this actually stops.
    const dialog = byTestId('heartbeat-turn-off-confirm')
    expect(dialog.textContent).toContain('Support triage')
    expect(dialog.textContent).toContain('$0.90')

    fireEvent.click(screen.getByLabelText('Turn off heartbeat'))

    await waitFor(() => expect(http.patch).toHaveBeenCalledTimes(1))
    expect(http.patch.mock.calls[0][0]).toBe('/api/projects/proj_1/heartbeat')
    expect(http.patch.mock.calls[0][1]).toEqual({ heartbeatEnabled: false })
    // Re-read afterwards so the row cannot claim a schedule that no longer runs.
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
  })

  test('a row the caller may not edit offers no turn-off', async () => {
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Nightly digest')

    expect(rnTestId('heartbeat-turn-off-proj_2')).toBeNull()
    // An already-off agent has nothing to turn off either.
    expect(rnTestId('heartbeat-turn-off-proj_1')).toBeTruthy()
  })

  test('a failed turn-off surfaces the message and leaves the rows alone', async () => {
    http.patch.mockImplementation(async () => {
      throw Object.assign(new Error('forbidden: no access'), { status: 403 })
    })
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Support triage')

    fireEvent.click(byTestId('heartbeat-turn-off-proj_1'))
    fireEvent.click(screen.getByLabelText('Turn off heartbeat'))

    expect(await screen.findByText(/forbidden: no access/)).toBeTruthy()
    expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1)
  })

  test('a row whose charges ran on another model says so', async () => {
    getWorkspaceAnalytics.mockImplementation(async () =>
      report({
        agents: [
          agent({
            configuredModel: 'claude-sonnet-4',
            modelsUsed: [{ model: 'claude-haiku-4', billedUsd: 0.9 }],
          }),
        ],
      }),
    )
    render(<WorkspaceHeartbeatsPanel />)

    await screen.findByText('ran on Claude haiku-4')
    expect(rnTestId('heartbeat-model-mismatch-proj_1')).toBeTruthy()
    expect(screen.getByText('ran on Claude haiku-4')).toBeTruthy()
  })

  test('tapping a row opens that project', async () => {
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Support triage')

    fireEvent.click(byTestId('heartbeat-row-proj_1'))
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toMatchObject({
      pathname: '/(app)/projects/[id]',
      params: { id: 'proj_1' },
    })
  })

  test('sorting by spend flips the order', async () => {
    render(<WorkspaceHeartbeatsPanel />)
    await screen.findByText('Support triage')

    fireEvent.click(byTestId('heartbeat-sort-Spend'))
    const table = byTestId('heartbeats-table')
    await waitFor(() =>
      expect(table.textContent!.indexOf('Nightly digest')).toBeLessThan(
        table.textContent!.indexOf('Support triage'),
      ),
    )
  })
})

describe('heartbeat formatting helpers', () => {
  test('formatInterval speaks in the units an operator thinks in', () => {
    expect(formatInterval(1800)).toBe('every 30 min')
    expect(formatInterval(900)).toBe('every 15 min')
    expect(formatInterval(3600)).toBe('every 1h')
    expect(formatInterval(5400)).toBe('every 1.5h')
    expect(formatInterval(86_400)).toBe('every 1d')
    expect(formatInterval(0)).toBe('—')
  })

  test('relativeTick covers past, future and missing timestamps', () => {
    const now = new Date('2026-10-24T12:00:00.000Z')
    expect(relativeTick(null, now)).toBe('—')
    expect(relativeTick('2026-10-24T11:48:00.000Z', now)).toBe('12m ago')
    expect(relativeTick('2026-10-24T12:20:00.000Z', now)).toBe('in 20m')
    expect(relativeTick('2026-10-24T09:00:00.000Z', now)).toBe('3h ago')
    expect(relativeTick('2026-10-22T12:00:00.000Z', now)).toBe('2d ago')
    expect(relativeTick('2026-10-24T11:59:40.000Z', now)).toBe('just now')
  })

  test('formatShareOfSpend rounds, floors small shares and refuses a zero denominator', () => {
    expect(formatShareOfSpend(1.1, 4.4)).toBe('25%')
    expect(formatShareOfSpend(0.01, 4.4)).toBe('<1%')
    expect(formatShareOfSpend(0, 4.4)).toBe('0%')
    expect(formatShareOfSpend(1, 0)).toBe('—')
  })

  test('modelMismatch is quiet when the configured model is among those charged', () => {
    expect(modelMismatch(agent())).toBeNull()
    expect(modelMismatch(agent({ modelsUsed: [] }))).toBeNull()
    expect(modelMismatch(agent({ modelsUsed: [{ model: 'other', billedUsd: 1 }] }))).toBe('other')
  })

  test('sortHeartbeatRows breaks ties by name so the order is stable', () => {
    const rows = [
      agent({ projectId: 'a', projectName: 'B', billedUsd: 1 }),
      agent({ projectId: 'b', projectName: 'A', billedUsd: 1 }),
      agent({ projectId: 'c', projectName: 'C', billedUsd: 2 }),
    ]
    expect(sortHeartbeatRows(rows, 'spend', 'desc').map((r) => r.projectName)).toEqual(['C', 'A', 'B'])
    expect(sortHeartbeatRows(rows, 'spend', 'asc').map((r) => r.projectName)).toEqual(['A', 'B', 'C'])
  })
})
