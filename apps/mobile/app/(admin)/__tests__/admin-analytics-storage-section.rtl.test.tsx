// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-423 — the Storage section on Admin → Analytics.
 *
 * QA round 1 caught two failures here that no component test covered: the
 * section read `data.month.mode` unguarded (a rolling deploy, or a mock, can
 * answer `{ ok: true }`), which threw inside render and took the whole page —
 * including the untouched panels — down with it. This file pins both the
 * rendered numbers and the degrade path, so the page's storage UI no longer
 * depends on the local e2e stack (whose shard is cancelled more often than it
 * completes).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

import * as ReactNativeWeb from 'react-native-web'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'

/** `react-native` resolves twice in this monorepo (app + shared-ui); both need the web copy. */
const sharedUiRequire = createRequire(
  resolvePath(import.meta.dir, '../../../../../packages/shared-ui/src/noop.js'),
)
mock.module('react-native', () => ReactNativeWeb)
mock.module(sharedUiRequire.resolve('react-native'), () => ReactNativeWeb)

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))

/** Shape `GET /api/admin/storage` returns, in full. */
const STORAGE_SUMMARY = {
  lastPassAt: '2026-11-18T12:00:00.000Z',
  buckets: { measuredBytes: 4096, workspaces: 2 },
  categories: { project_files: 1024, repo: 2048, assets: 0, backups: 0, quarantine: 1024 },
  billableBytes: 3072,
  overheadBytes: 1024,
  unmeasured: [],
  month: { gbMonths: 0.25, shadowUsd: 0.04, chargedUsd: 0.03, mode: 'shadow' },
  topByBytes: [{ workspaceId: 'ws-1', name: 'Acme', totalBytes: 4096, billableBytes: 3072, allowanceBytes: 1024 }],
  topByOverage: [{ workspaceId: 'ws-1', name: 'Acme', totalBytes: 4096, overageBytes: 3072, allowanceBytes: 1024 }],
}

const storageResponse: { body: unknown } = { body: { ok: true, data: STORAGE_SUMMARY } }

const fetchAdminJson = mock(async (path: string) => {
  if (path === '/storage') return (storageResponse.body as { data?: unknown }).data ?? { ok: true }
  if (path === '/analytics/ai-digest/list') return []
  if (path === '/analytics/activity-timeseries' || path === '/analytics/active-users-timeseries') return []
  return { ok: true }
})

mock.module('../_analytics-shared', () => ({
  API_BASE: 'http://api.test/api/admin',
  fetchAdminJson,
  AnalyticsHeader: () => null,
}))

mock.module('../../../components/analytics/SharedAnalytics', () => {
  const Panel = () => null
  return {
    // The real card renders its label and value; the default mock hides them,
    // which would leave the section's numbers unasserted.
    StatCard: ({ label, value }: { label: string; value: unknown }) => (
      <div data-testid="stat-card">{`${label}=${String(value)}`}</div>
    ),
    FunnelSection: Panel,
    SourceBreakdownPanel: Panel,
    AIInsightsPanel: Panel,
    ActivityTrendsChart: Panel,
    ActiveUsersTrendChart: Panel,
    UserActivityTable: () => <div data-testid="user-table" />,
  }
})

const { default: AdminMarketingAnalyticsPage } = await import('../admin/analytics')

beforeEach(() => {
  fetchAdminJson.mockClear()
  storageResponse.body = { ok: true, data: STORAGE_SUMMARY }
})

afterEach(cleanup)

describe('admin analytics storage section', () => {
  test('renders the platform footprint, the billable/overhead split and the month estimate', async () => {
    const { getByText, getAllByText, getAllByTestId } = render(<AdminMarketingAnalyticsPage />)

    await waitFor(() => expect(getByText('By category')).toBeTruthy())

    // Stat row: the three byte totals plus the month's shadow revenue.
    const stats = getAllByTestId('stat-card').map((el) => el.textContent)
    expect(stats).toContain('Measured=4 KB')
    expect(stats).toContain('Billable=3 KB')
    expect(stats).toContain('Overhead=1 KB')
    expect(stats).toContain('Month (est.)=$0.04')

    // Categories, each formatted through `formatStorageBytes`.
    expect(getByText('Project files')).toBeTruthy()
    expect(getByText('Git & LFS')).toBeTruthy()
    // project_files and quarantine are both 1 KB; git & LFS is 2 KB.
    expect(getAllByText('1 KB')).toHaveLength(2)
    expect(getAllByText('2 KB')).toHaveLength(1)

    // Overhead is named as such, and the shadow mode says nobody was charged.
    expect(getByText('Quarantine (overhead)')).toBeTruthy()
    expect(getByText('2 workspaces · shadow (not charged)')).toBeTruthy()
    expect(getByText('0.250 billable GB-months this month · would charge $0.04')).toBeTruthy()

    // Ranked workspaces, by total and by overage.
    expect(getByText('Biggest workspaces')).toBeTruthy()
    expect(getByText('Over allowance')).toBeTruthy()
    // Acme is ranked on both boards; 3 KB is its overage.
    expect(getAllByText('Acme')).toHaveLength(2)
    expect(getAllByText('3 KB')).toHaveLength(1)
    expect(getByText(/Last pass /)).toBeTruthy()
  })

  test('an enforced month reports what was charged, not what it would have cost', async () => {
    storageResponse.body = {
      ok: true,
      data: { ...STORAGE_SUMMARY, month: { ...STORAGE_SUMMARY.month, mode: 'enforce' } },
    }
    const { getByText, getAllByTestId } = render(<AdminMarketingAnalyticsPage />)

    await waitFor(() => expect(getByText('By category')).toBeTruthy())
    expect(getByText('2 workspaces · enforced')).toBeTruthy()
    expect(getByText('0.250 billable GB-months this month · charged $0.03')).toBeTruthy()
    // Enforced months carry no "(est.)" suffix — the label keeps a trailing space.
    expect(getAllByTestId('stat-card').map((el) => el.textContent)).toContain('Month =$0.04')
  })

  test('an unmeasured category is called out instead of counted as zero', async () => {
    storageResponse.body = {
      ok: true,
      data: { ...STORAGE_SUMMARY, unmeasured: ['vm_snapshots'] },
    }
    const { getByText } = render(<AdminMarketingAnalyticsPage />)

    await waitFor(() => expect(getByText('Not measured: vm_snapshots')).toBeTruthy())
  })

  test("an older pod's payload says so instead of taking the page down", async () => {
    // Regression from QA round 1: `{ ok: true }` has no `month`, and reading
    // `data.month.mode` threw inside render — the whole page unmounted.
    storageResponse.body = { ok: true }
    const { getByText, getByTestId } = render(<AdminMarketingAnalyticsPage />)

    await waitFor(() => expect(getByText('Storage data unavailable.')).toBeTruthy())
    // The section degrades and every other panel is still mounted.
    expect(getByTestId('user-table')).toBeTruthy()
    expect(getByText('Active Users')).toBeTruthy()
  })
})
