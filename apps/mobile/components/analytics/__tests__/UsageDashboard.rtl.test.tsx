// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const http = { id: 'http' }
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => http }))

const getMyAnalytics = mock(async (..._args: any[]): Promise<any> => ({}))
const getWorkspaceAnalytics = mock(async (..._args: any[]): Promise<any> => ({}))
mock.module('../../../lib/api', () => ({ api: { getMyAnalytics, getWorkspaceAnalytics } }))

mock.module('../../../lib/native-phone-layout', () => ({ useIsNativePhoneLayout: () => false }))
mock.module('../../../lib/native-active-shadow', () => ({
  nativeActivePill: () => ({ className: '', style: undefined }),
}))
mock.module('../../settings/account-sheet-chrome', () => ({
  Text: ({ children, ...props }: any) => createElement('span', props, children),
}))
// The real module drags in the model catalog; the dashboard only needs these two exports.
mock.module('../SharedAnalytics', () => ({
  StatCard: ({ label, value, subtitle }: any) =>
    createElement('div', { 'data-testid': `stat-${label}` }, [
      createElement('span', { key: 'l' }, label),
      createElement('span', { key: 'v', 'data-testid': `value-${label}` }, String(value)),
      subtitle ? createElement('span', { key: 's' }, subtitle) : null,
    ]),
  formatDollarCost: (n: number) => `$${n.toFixed(2)}`,
}))
mock.module('../StackedAreaChart', () => ({
  STACKED_PALETTE: ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#slate'],
  StackedAreaChart: ({ days, series }: any) =>
    createElement('div', { 'data-testid': 'daily-chart', 'data-days': days.length, 'data-series': series.map((s: any) => s.id).join(',') }),
}))

const { UsageDashboard } = await import('../UsageDashboard')
const { TeamWorkTable, sortTeamRows } = await import('../TeamWorkTable')

const totals = (over: Record<string, any> = {}) => ({
  messagesSent: 14,
  approvalsDecided: 6,
  approvalsApproved: 5,
  approvalsDenied: 1,
  tasksStarted: 9,
  tasksCompleted: 7,
  toolCalls: 120,
  linesAdded: 800,
  linesRemoved: 200,
  projectsTouched: 3,
  meetings: 2,
  agentRequests: 40,
  sessions: 11,
  tokens: 1_250_000,
  spendUsd: 4.2,
  activeDays: 12,
  lastActiveAt: '2026-07-07T12:00:00.000Z',
  ...over,
})

const stats = (over: Record<string, any> = {}) => ({
  tz: 'America/Los_Angeles',
  from: '2026-06-07T00:00:00.000Z',
  to: '2026-07-07T00:00:00.000Z',
  totals: totals(),
  streak: { current: 3, longest: 8 },
  peakHour: 9,
  heatmap: [
    { date: '2026-07-05', count: 0, tokens: 0 },
    { date: '2026-07-06', count: 4, tokens: 1000 },
    { date: '2026-07-07', count: 9, tokens: 5000 },
  ],
  hourOfWeek: Array.from({ length: 7 }, () => new Array(24).fill(0)),
  modelShare: [
    { model: 'Claude Sonnet', tokens: 900_000, pct: 72 },
    { model: 'GPT', tokens: 350_000, pct: 28 },
  ],
  topTools: [{ toolName: 'edit_file', count: 80, successRate: 0.95 }],
  daily: {
    days: [
      { date: '2026-07-06', byModel: { 'Claude Sonnet': 600, GPT: 400 }, total: 1000 },
      { date: '2026-07-07', byModel: { 'Claude Sonnet': 3000, GPT: 2000 }, total: 5000 },
    ],
    models: ['Claude Sonnet', 'GPT'],
  },
  recent: [
    { kind: 'task_completed', at: '2026-07-07T10:00:00.000Z', label: 'Write launch docs', detail: 'Shipped' },
    { kind: 'approval', at: '2026-07-07T09:00:00.000Z', label: 'Merge pull request #12', detail: 'Approved' },
  ],
  ...over,
})

beforeEach(() => {
  getMyAnalytics.mockReset()
  getWorkspaceAnalytics.mockReset()
  getMyAnalytics.mockImplementation(async () => stats())
  getWorkspaceAnalytics.mockImplementation(async () => stats())
})

describe('UsageDashboard', () => {
  test('renders the personal dashboard from /me with the device timezone', async () => {
    render(<UsageDashboard source={{ kind: 'me' }} title="Your activity" />)

    expect(await screen.findByText('Work activity')).toBeTruthy()
    expect(getMyAnalytics).toHaveBeenCalledTimes(1)
    const [passedHttp, endpoint, params] = getMyAnalytics.mock.calls[0]
    expect(passedHttp).toBe(http)
    expect(endpoint).toBe('engagement')
    expect(params.period).toBe('30d')
    expect(typeof params.tz).toBe('string')
    expect(params).not.toHaveProperty('userId')
    expect(getWorkspaceAnalytics).not.toHaveBeenCalled()

    // Z Code-style headline numbers.
    expect(screen.getByTestId('value-Tokens').textContent).toBe('1.3M')
    expect(screen.getByTestId('value-Current streak').textContent).toBe('3 days')
    expect(screen.getByTestId('value-Longest streak').textContent).toBe('8 days')
    expect(screen.getByTestId('value-Peak hour').textContent).toBe('9 AM')

    // Work activity.
    expect(screen.getByText('5 approved · 1 denied')).toBeTruthy()
    expect(screen.getByText('9 started')).toBeTruthy()
    expect(screen.getByText('Write launch docs')).toBeTruthy()
    expect(screen.getByText('Merge pull request #12')).toBeTruthy()

    // Charts and panels.
    expect(screen.getByTestId('daily-chart').getAttribute('data-series')).toBe('Claude Sonnet,GPT')
    expect(screen.getByText('72.0%')).toBeTruthy()
    expect(screen.getByText(/edit_file/)).toBeTruthy()
  })

  test('a workspace source requests that workspace, and one member when given', async () => {
    const { unmount } = render(<UsageDashboard source={{ kind: 'workspace', workspaceId: 'ws_1' }} />)
    await screen.findByText('Work activity')
    expect(getWorkspaceAnalytics.mock.calls[0].slice(1, 3)).toEqual(['ws_1', 'engagement'])
    expect(getWorkspaceAnalytics.mock.calls[0][3]).not.toHaveProperty('userId')
    // Whole-workspace views call the streak a team streak.
    expect(screen.getByTestId('stat-Team streak')).toBeTruthy()
    unmount()

    getWorkspaceAnalytics.mockClear()
    render(<UsageDashboard source={{ kind: 'workspace', workspaceId: 'ws_1', userId: 'alice' }} />)
    await screen.findByText('Work activity')
    expect(getWorkspaceAnalytics.mock.calls[0][3].userId).toBe('alice')
    expect(screen.getByTestId('stat-Current streak')).toBeTruthy()
  })

  test('switching the range refetches', async () => {
    render(<UsageDashboard source={{ kind: 'me' }} />)
    await screen.findByText('Work activity')

    fireEvent.click(screen.getByText('Last 7 days'))
    await waitFor(() => expect(getMyAnalytics).toHaveBeenCalledTimes(2))
    expect(getMyAnalytics.mock.calls[1][2].period).toBe('7d')

    fireEvent.click(screen.getByText('All time'))
    await waitFor(() => expect(getMyAnalytics).toHaveBeenCalledTimes(3))
    expect(getMyAnalytics.mock.calls[2][2].period).toBe('all')
  })

  test('a slow earlier response never overwrites a newer one', async () => {
    let resolveFirst!: (v: any) => void
    getMyAnalytics.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    getMyAnalytics.mockImplementationOnce(async () => stats({ streak: { current: 5, longest: 5 } }))

    render(<UsageDashboard source={{ kind: 'me' }} />)
    fireEvent.click(screen.getByText('Last 7 days'))
    await waitFor(() => expect(screen.getByTestId('value-Current streak').textContent).toBe('5 days'))

    // The first (30d) request finally lands, late and different.
    resolveFirst(stats({ streak: { current: 99, longest: 99 } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId('value-Current streak').textContent).toBe('5 days')
  })

  test('an empty period says so instead of rendering zeros as if they were data', async () => {
    getMyAnalytics.mockImplementation(async () =>
      stats({
        totals: totals({ activeDays: 0, tokens: 0, approvalsDecided: 0, tasksCompleted: 0 }),
        peakHour: null,
        modelShare: [],
        topTools: [],
        recent: [],
        daily: { days: [], models: [] },
      }),
    )
    render(<UsageDashboard source={{ kind: 'me' }} />)
    expect(await screen.findByText('No activity in this period yet.')).toBeTruthy()
    expect(screen.getByText('No token usage in this period')).toBeTruthy()
    expect(screen.getByTestId('value-Peak hour').textContent).toBe('—')
  })

  test('errors show a message and Retry refetches', async () => {
    getMyAnalytics.mockImplementationOnce(async () => {
      throw new Error('Network down')
    })
    render(<UsageDashboard source={{ kind: 'me' }} />)
    expect(await screen.findByText('Network down')).toBeTruthy()

    fireEvent.click(screen.getByText('Retry'))
    expect(await screen.findByText('Work activity')).toBeTruthy()
    expect(getMyAnalytics).toHaveBeenCalledTimes(2)
  })
})

const row = (userId: string, name: string, t: Record<string, any> = {}, streak = 0, role: string | null = 'member') => ({
  userId,
  name,
  email: `${userId}@x.co`,
  image: null,
  role,
  totals: totals(t),
  streak: { current: streak, longest: streak },
})

describe('sortTeamRows', () => {
  const rows = [
    row('a', 'Alice', { approvalsDecided: 2, tasksCompleted: 9 }, 3),
    row('b', 'Bob', { approvalsDecided: 8, tasksCompleted: 1 }, 1),
    row('c', 'Cara', { approvalsDecided: 8, tasksCompleted: 5 }, 7),
  ]

  test('sorts numerically in both directions', () => {
    expect(sortTeamRows(rows, 'approvals', 'desc').map((r) => r.userId)).toEqual(['b', 'c', 'a'])
    expect(sortTeamRows(rows, 'approvals', 'asc').map((r) => r.userId)).toEqual(['a', 'b', 'c'])
    expect(sortTeamRows(rows, 'streak', 'desc').map((r) => r.userId)).toEqual(['c', 'a', 'b'])
  })

  test('ties fall back to name so order is stable', () => {
    expect(sortTeamRows(rows, 'approvals', 'desc').slice(0, 2).map((r) => r.name)).toEqual(['Bob', 'Cara'])
  })

  test('sorts names case-insensitively and does not mutate its input', () => {
    const input = [row('x', 'zed'), row('y', 'Amy')]
    expect(sortTeamRows(input, 'name', 'asc').map((r) => r.name)).toEqual(['Amy', 'zed'])
    expect(input.map((r) => r.name)).toEqual(['zed', 'Amy'])
  })
})

describe('TeamWorkTable', () => {
  const team = {
    tz: 'UTC',
    from: '',
    to: '',
    team: totals({ approvalsDecided: 10, tasksCompleted: 15, messagesSent: 30 }),
    rows: [
      row('a', 'Alice', { approvalsDecided: 2, tasksCompleted: 9 }, 3, 'admin'),
      row('b', 'Bob', { approvalsDecided: 8, tasksCompleted: 1 }, 1),
      row('gone', 'Former Fred', { approvalsDecided: 0 }, 0, null),
    ],
  }

  test('a workspace below Business sees an upgrade note and makes no request', () => {
    render(<TeamWorkTable workspaceId="ws_1" locked />)
    expect(screen.getByText(/Business plan/)).toBeTruthy()
    expect(getWorkspaceAnalytics).not.toHaveBeenCalled()
  })

  test('lists members busiest first, flags former members, and opens a member on tap', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => team)
    const onSelect = mock((_id: string, _label: string) => {})
    render(<TeamWorkTable workspaceId="ws_1" onSelectMember={onSelect} />)

    expect(await screen.findByText('Bob')).toBeTruthy()
    expect(getWorkspaceAnalytics.mock.calls[0].slice(1, 3)).toEqual(['ws_1', 'team-work'])
    expect(getWorkspaceAnalytics.mock.calls[0][3].period).toBe('7d')

    const names = screen.getAllByText(/^(Alice|Bob|Former Fred)$/).map((n) => n.textContent)
    expect(names).toEqual(['Bob', 'Alice', 'Former Fred'])
    expect(screen.getByText('Former member')).toBeTruthy()
    expect(screen.getByText('Team total')).toBeTruthy()

    fireEvent.click(screen.getByText('Alice'))
    expect(onSelect).toHaveBeenCalledWith('a', 'Alice')
  })

  test('clicking a column header re-sorts', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => team)
    render(<TeamWorkTable workspaceId="ws_1" />)
    await screen.findByText('Bob')

    fireEvent.click(screen.getByText('Tasks done'))
    const names = screen.getAllByText(/^(Alice|Bob|Former Fred)$/).map((n) => n.textContent)
    expect(names[0]).toBe('Alice')
  })

  test('shows the server error rather than an empty table', async () => {
    getWorkspaceAnalytics.mockImplementation(async () => {
      throw new Error('Only workspace owners and admins can view team activity')
    })
    render(<TeamWorkTable workspaceId="ws_1" />)
    expect(await screen.findByText(/Only workspace owners and admins/)).toBeTruthy()
  })
})
