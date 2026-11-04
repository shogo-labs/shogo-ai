// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 — each panel on the marketing admin analytics page owns its request.
 *
 * Before this change one `loadAll` held every param in its dependency list, so
 * paging the twenty-row user-activity table re-fetched the platform overview,
 * both timeseries, the funnel, the signup-source breakdown and the AI digest as
 * well. QA round 1 asked for a request-count test on this page; this is it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import * as ReactNativeWeb from 'react-native-web'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'

/**
 * `react-native` resolves to two copies in this monorepo — one for `apps/mobile`
 * and a second one for `packages/shared-ui` — and `mock.module` keys on the
 * resolved file, so a bare specifier only covers this app's copy. The page
 * imports `cn` from shared-ui, whose copy would otherwise evaluate real React
 * Native and fail the file before a single assertion runs ("Unexpected typeof"
 * in `react-native/index.js`).
 */
const sharedUiRequire = createRequire(
  resolvePath(import.meta.dir, '../../../../../packages/shared-ui/src/noop.js'),
)
mock.module('react-native', () => ReactNativeWeb)
mock.module(sharedUiRequire.resolve('react-native'), () => ReactNativeWeb)

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))

const fetchCalls: { path: string; params?: Record<string, string> }[] = []
const fetchAdminJson = mock(async (path: string, params?: Record<string, string>) => {
  fetchCalls.push({ path, params })
  if (path === '/analytics/activity-timeseries' || path === '/analytics/active-users-timeseries') return []
  if (path === '/analytics/ai-digest/list') return []
  return { ok: true }
})

mock.module('../_analytics-shared', () => ({
  API_BASE: 'http://api.test/api/admin',
  fetchAdminJson,
  AnalyticsHeader: () => null,
}))

mock.module('../../../components/analytics/SharedAnalytics', () => {
  const Pager = ({ testId, onPageChange }: { testId: string; onPageChange: (n: number) => void }) => (
    <button data-testid={testId} onClick={() => onPageChange(2)}>
      next
    </button>
  )
  return {
    StatCard: () => null,
    FunnelSection: () => null,
    SourceBreakdownPanel: () => null,
    AIInsightsPanel: () => null,
    ActivityTrendsChart: () => null,
    ActiveUsersTrendChart: () => null,
    UserActivityTable: ({ onPageChange }: any) => (
      <Pager testId="user-next" onPageChange={onPageChange} />
    ),
  }
})

const { default: AdminMarketingAnalyticsPage } = await import('../admin/analytics')

const callsFor = (path: string) => fetchCalls.filter((c) => c.path === path).length

beforeEach(() => {
  fetchCalls.length = 0
  fetchAdminJson.mockClear()
})

afterEach(cleanup)

describe('admin marketing analytics page', () => {
  test('loads each panel exactly once on mount', async () => {
    const { getByTestId } = render(<AdminMarketingAnalyticsPage />)

    await waitFor(() => expect(fetchCalls).toHaveLength(9))
    expect(getByTestId('user-next')).toBeTruthy()
    for (const path of [
      '/analytics/overview',
      '/analytics/active-users',
      '/analytics/activity-timeseries',
      '/analytics/active-users-timeseries',
      '/analytics/funnel',
      '/analytics/user-activity',
      '/analytics/source-breakdown',
      '/analytics/ai-digest',
      '/analytics/ai-digest/list',
    ]) {
      expect(callsFor(path)).toBe(1)
    }
  })

  test('paging the user table refetches only the user table', async () => {
    const { getByTestId } = render(<AdminMarketingAnalyticsPage />)
    await waitFor(() => expect(fetchCalls).toHaveLength(9))

    fireEvent.click(getByTestId('user-next'))
    await waitFor(() => expect(callsFor('/analytics/user-activity')).toBe(2))

    expect(fetchCalls).toHaveLength(10)
    expect(callsFor('/analytics/overview')).toBe(1)
    expect(callsFor('/analytics/funnel')).toBe(1)
    expect(callsFor('/analytics/ai-digest')).toBe(1)
    expect(callsFor('/analytics/active-users-timeseries')).toBe(1)
    expect(fetchCalls.filter((c) => c.path === '/analytics/user-activity').at(-1)?.params).toMatchObject({
      page: '2',
      limit: '20',
    })
  })
})
