// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-140 acceptance 3 and 4 — the Usage tab's request count.
 *
 * Opening the tab used to fire five requests at once, and one chart toggle
 * refetched all of them. These tests pin the new contract: two requests on
 * open (`dashboard` + `usage-log`), one on a chart toggle, one on a log page
 * change — and a param change never blanks the section back to a spinner.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => {
  const base = createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  })
  return base
})
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const http = { id: 'http' }
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => http }))

const getWorkspaceAnalytics = mock(async (..._args: any[]): Promise<any> => ({}))
const realApiModule = await import('../../../lib/api')
mock.module('../../../lib/api', () => ({
  ...realApiModule,
  api: { ...realApiModule.api, getWorkspaceAnalytics },
}))

mock.module('expo-router', () => ({ useRouter: () => ({ push: () => {}, navigate: () => {} }) }))
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws_1', name: 'Acme' }),
}))
mock.module('../../../hooks/useCloudBillingSummary', () => ({
  useCloudBillingSummary: () => ({ summary: null, refresh: async () => {}, setSpendingLimit: async () => {} }),
}))
mock.module('@shogo/shared-app/hooks', () => ({
  useBillingData: () => ({
    subscription: { planId: 'local' },
    effectiveBalance: null,
    usageWindows: null,
    refetchUsageWallet: () => {},
  }),
}))
mock.module('../../../lib/billing-config', () => ({
  getWindowDisplays: () => ({
    fiveHour: { pct: 10, uncapped: false, countdown: '2h' },
    weekly: { pct: 20, uncapped: false, countdown: '3d' },
  }),
}))
mock.module('../../../lib/usage-log-csv', () => ({ useUsageLogCsvUrl: () => 'http://x/usage.csv' }))
mock.module('../../../lib/platform-config', () => ({ usePlatformConfig: () => ({ localMode: true }) }))
const realVisibleModels = await import('../../../lib/visible-models')
mock.module('../../../lib/visible-models', () => ({
  ...realVisibleModels,
  useVisibleModels: () => {},
}))
mock.module('../../../lib/native-active-shadow', () => ({
  nativeActivePill: () => ({ className: '', style: undefined }),
}))
const realAccountSheetChrome = await import('../../settings/account-sheet-chrome')
mock.module('../../settings/account-sheet-chrome', () => ({
  ...realAccountSheetChrome,
  Text: ({ children, ...props }: any) => createElement('span', props, children),
  useAccountSheetIcons: () => ({
    Coins: () => null,
    CreditCard: () => null,
    Download: () => null,
    Zap: () => null,
  }),
  accountSheetIcon: (icon: any) => icon,
}))
mock.module('../../billing/BillingProgressCard', () => ({
  BillingProgressCard: ({ title }: any) => createElement('div', {}, title),
}))
mock.module('../../billing/SetSpendLimitDialog', () => ({ SetSpendLimitDialog: () => null }))
mock.module('../LoadErrorNotice', () => ({
  LoadErrorNotice: ({ errors }: any) =>
    createElement('div', { 'data-testid': 'load-errors' }, Object.keys(errors ?? {}).join(',')),
}))
mock.module('../UsageLeaderboard', () => ({ UsageLeaderboard: () => null }))
mock.module('../WorkspaceActivitySection', () => ({ WorkspaceActivitySection: () => null }))
// Keep every real export (other files in this directory import them) and stub
// only the four heavy components this panel renders.
const realSharedAnalytics = await import('../SharedAnalytics')
mock.module('../SharedAnalytics', () => ({
  ...realSharedAnalytics,
  StatCard: ({ label, value }: any) =>
    createElement('div', { 'data-testid': `stat-${label}` }, String(value)),
  UsageTableSection: ({ onLogPageChange, logPage, onSummaryPageChange, summaryPage }: any) =>
    createElement('div', { 'data-testid': 'usage-table' }, [
      createElement('span', { key: 's', 'data-testid': 'summary-page' }, String(summaryPage)),
      createElement('button', { key: 'snext', 'data-testid': 'summary-next', onClick: () => onSummaryPageChange(summaryPage + 1) }, 'summary next'),
      createElement('span', { key: 'l', 'data-testid': 'log-page' }, String(logPage)),
      createElement('button', { key: 'lnext', 'data-testid': 'log-next', onClick: () => onLogPageChange(logPage + 1) }, 'log next'),
    ]),
  ChatAnalyticsSection: () => null,
  UsageBreakdownSection: () => null,
  UsageTimeseriesChart: ({ onGroupByChange, onMetricChange }: any) =>
    createElement('div', { 'data-testid': 'chart' }, [
      createElement('button', { key: 'g', 'data-testid': 'chart-user', onClick: () => onGroupByChange('user') }, 'by user'),
      createElement('button', { key: 'm', 'data-testid': 'chart-tokens', onClick: () => onMetricChange('tokens') }, 'tokens'),
    ]),
}))
const { WorkspaceUsagePanel } = await import('../WorkspaceUsagePanel')

const dashboard = (over: Record<string, any> = {}) => ({
  window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', period: '7d' },
  summary: {
    summaries: [],
    totals: {
      totalRequests: 12,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalTokens: 120,
      totalBilledUsd: 0.5,
      totalRawUsd: 0.4,
      unpricedRequests: 0,
      totalToolCalls: 3,
      uniqueUsers: 1,
      uniqueModels: 1,
    },
    total: 120,
    page: 1,
    limit: 50,
  },
  timeseries: {
    days: [],
    totals: { totalSpendUsd: 0.5, totalIncludedUsd: 0.5, totalOnDemandUsd: 0, uniqueModels: 1 },
    models: [],
    groupBy: 'model',
    metric: 'spend',
  },
  usage: { totalSpendUsd: 0.5, actionBreakdown: [] },
  logCount: 12,
  chat: { totalSessions: 1, totalMessages: 2, totalToolCalls: 3, avgMessagesPerSession: 2 },
  ...over,
})

const logPage = (page = 1) => ({ entries: [], total: 120, page, limit: 50 })

/** Requests made to the analytics endpoints, in call order. */
function endpoints(): string[] {
  return getWorkspaceAnalytics.mock.calls.map((call: any[]) => call[2])
}

beforeEach(() => {
  getWorkspaceAnalytics.mockReset()
  getWorkspaceAnalytics.mockImplementation(async (_http: any, _ws: string, endpoint: string, params: any) => {
    if (endpoint === 'dashboard') return dashboard({ summary: { ...dashboard().summary, page: Number(params.page) } })
    if (endpoint === 'usage-log') return logPage(Number(params.page))
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
})

describe('WorkspaceUsagePanel', () => {
  test('opens with exactly two requests: the dashboard and the event log', async () => {
    render(<WorkspaceUsagePanel />)
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    expect(endpoints().sort()).toEqual(['dashboard', 'usage-log'])

    const [, workspaceId, , params] = getWorkspaceAnalytics.mock.calls.find((c: any[]) => c[2] === 'dashboard')!
    expect(workspaceId).toBe('ws_1')
    expect(params.period).toBe('7d')
    expect(params.limit).toBe('50')
  })

  test('a chart group-by toggle issues exactly one request', async () => {
    render(<WorkspaceUsagePanel />)
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    getWorkspaceAnalytics.mockClear()

    fireEvent.click(screen.getByTestId('chart-user'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1))
    expect(endpoints()).toEqual(['dashboard'])
    expect(getWorkspaceAnalytics.mock.calls[0][3].groupBy).toBe('user')
  })

  test('a chart metric toggle issues exactly one request', async () => {
    render(<WorkspaceUsagePanel />)
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    getWorkspaceAnalytics.mockClear()

    fireEvent.click(screen.getByTestId('chart-tokens'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1))
    expect(getWorkspaceAnalytics.mock.calls[0][3].metric).toBe('tokens')
  })

  test('paging the event log issues exactly one request, for the log', async () => {
    render(<WorkspaceUsagePanel />)
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    getWorkspaceAnalytics.mockClear()

    fireEvent.click(screen.getByTestId('log-next'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1))
    expect(endpoints()).toEqual(['usage-log'])
    expect(getWorkspaceAnalytics.mock.calls[0][3].page).toBe('2')
  })

  test('paging the summary table issues exactly one request, for page 2 of the same 50 rows', async () => {
    render(<WorkspaceUsagePanel />)
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    getWorkspaceAnalytics.mockClear()

    fireEvent.click(screen.getByTestId('summary-next'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(1))
    const params = getWorkspaceAnalytics.mock.calls[0][3]
    expect(endpoints()).toEqual(['dashboard'])
    expect(params.page).toBe('2')
    expect(params.limit).toBe('50')
    expect(await screen.findByTestId('summary-page')).toBeTruthy()
  })

  test('a period change reloads both, from page 1, without blanking the section', async () => {
    render(<WorkspaceUsagePanel />)
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    getWorkspaceAnalytics.mockClear()

    fireEvent.click(screen.getByText('30d'))
    await waitFor(() => expect(getWorkspaceAnalytics).toHaveBeenCalledTimes(2))
    expect(endpoints().sort()).toEqual(['dashboard', 'usage-log'])
    for (const call of getWorkspaceAnalytics.mock.calls as any[]) {
      expect(call[3].period).toBe('30d')
      if (call[2] === 'usage-log') expect(call[3].page).toBe('1')
    }
    // The previous summary stays on screen while the new window loads.
    expect(screen.getByTestId('stat-Total spend')).toBeTruthy()
  })

  test('a failure surfaces the server message instead of a blank panel', async () => {
    getWorkspaceAnalytics.mockImplementation(async (_h: any, _w: string, endpoint: string) => {
      if (endpoint === 'dashboard') throw new Error('Analytics temporarily unavailable')
      return logPage()
    })
    render(<WorkspaceUsagePanel />)
    await waitFor(() =>
      expect(screen.getByTestId('load-errors').textContent).toContain('usage'),
    )
    expect(getWorkspaceAnalytics).toHaveBeenCalled()
  })
})
