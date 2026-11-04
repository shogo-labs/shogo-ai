// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 — each panel on the admin AI analytics page owns its own request.
 *
 * The page used to load all eight panels from one `loadAll` whose dependency
 * list held every param, so pressing next on the twenty-row workspace table
 * refetched the spend chart, the quality chart, tool calls, the usage ledger,
 * the conversation stats and the distribution breakdown too. This renders the
 * real page with a stubbed fetch and asserts what each page change actually
 * asks the API for.
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
/** When set, workspace-activity resolves only when the test says so. */
let workspaceResolvers: ((value: unknown) => void)[] | null = null

const fetchAdminJson = mock(async (path: string, params?: Record<string, string>) => {
  fetchCalls.push({ path, params })
  if (path === '/analytics/workspace-activity' && workspaceResolvers) {
    return await new Promise((resolve) => workspaceResolvers!.push(resolve))
  }
  if (path === '/analytics/workspace-activity') return { page: params?.page }
  if (path === '/analytics/quality-timeseries') return []
  return { ok: true }
})

mock.module('../_analytics-shared', () => ({
  API_BASE: 'http://api.test/api/admin',
  fetchAdminJson,
  AnalyticsHeader: () => null,
}))

mock.module('../../../components/analytics/SharedAnalytics', () => {
  const Pager = ({ prefix, onPageChange }: { prefix: string; onPageChange: (n: number) => void }) => (
    <button data-testid={`${prefix}-next`} onClick={() => onPageChange(2)}>
      next
    </button>
  )
  return {
    UsageTableSection: ({ onLogPageChange, onSummaryPageChange }: any) => (
      <>
        <Pager prefix="log" onPageChange={onLogPageChange} />
        <Pager prefix="summary" onPageChange={onSummaryPageChange} />
      </>
    ),
    WorkspaceActivityTable: ({ data, onPageChange }: any) => (
      <>
        <Pager prefix="workspace" onPageChange={onPageChange} />
        <span data-testid="workspace-page">{data?.page ?? ''}</span>
      </>
    ),
    ToolCallAnalyticsPanel: ({ onPageChange }: any) => <Pager prefix="tool" onPageChange={onPageChange} />,
    ChatAnalyticsSection: () => null,
    UsageBreakdownSection: () => null,
    UsageTimeseriesChart: () => null,
    QualityTimeseriesChart: () => null,
  }
})

const { default: AdminAIAnalyticsPage } = await import('../ai-analytics')

function callsFor(path: string): number {
  return fetchCalls.filter((c) => c.path === path).length
}

beforeEach(() => {
  fetchCalls.length = 0
  workspaceResolvers = null
  fetchAdminJson.mockClear()
})

afterEach(cleanup)

describe('admin AI analytics page', () => {
  test('loads each panel exactly once on mount', async () => {
    const { getByTestId } = render(<AdminAIAnalyticsPage />)

    await waitFor(() => expect(fetchCalls).toHaveLength(8))
    expect(getByTestId('tool-next')).toBeTruthy()
    expect(callsFor('/analytics/spend-timeseries')).toBe(1)
    expect(callsFor('/analytics/quality-timeseries')).toBe(1)
    expect(callsFor('/analytics/tool-calls')).toBe(1)
    expect(callsFor('/analytics/workspace-activity')).toBe(1)
    expect(callsFor('/analytics/usage')).toBe(1)
    expect(callsFor('/analytics/usage-summary')).toBe(1)
    expect(callsFor('/analytics/usage-log')).toBe(1)
    expect(callsFor('/analytics/chat')).toBe(1)
  })

  test('paging one table refetches only that table', async () => {
    const { getByTestId } = render(<AdminAIAnalyticsPage />)
    await waitFor(() => expect(fetchCalls).toHaveLength(8))

    fireEvent.click(getByTestId('workspace-next'))
    await waitFor(() => expect(callsFor('/analytics/workspace-activity')).toBe(2))

    expect(fetchCalls).toHaveLength(9)
    expect(callsFor('/analytics/tool-calls')).toBe(1)
    expect(callsFor('/analytics/usage-log')).toBe(1)
    expect(callsFor('/analytics/spend-timeseries')).toBe(1)
    expect(fetchCalls.filter((c) => c.path === '/analytics/workspace-activity').at(-1)?.params).toMatchObject({
      page: '2',
      limit: '20',
    })
  })

  test('the two pages of the usage ledger are independent', async () => {
    const { getByTestId } = render(<AdminAIAnalyticsPage />)
    await waitFor(() => expect(fetchCalls).toHaveLength(8))

    fireEvent.click(getByTestId('log-next'))
    await waitFor(() => expect(callsFor('/analytics/usage-log')).toBe(2))

    expect(callsFor('/analytics/usage-summary')).toBe(1)
    expect(fetchCalls).toHaveLength(9)
  })

  /**
   * Plan §5, "guard against out-of-order responses": paging 1 → 2 with the
   * first request still in flight must not paint page 1 over page 2 when it
   * finally lands. Without the per-panel ticket the older resolution wins
   * simply because it is the last one to arrive.
   */
  test('a slow answer for an old page cannot overwrite a newer one', async () => {
    workspaceResolvers = []
    const { getByTestId } = render(<AdminAIAnalyticsPage />)
    await waitFor(() => expect(workspaceResolvers).toHaveLength(1))

    fireEvent.click(getByTestId('workspace-next'))
    await waitFor(() => expect(workspaceResolvers).toHaveLength(2))

    workspaceResolvers[1]({ page: '2' })
    await waitFor(() => expect(getByTestId('workspace-page').textContent).toBe('2'))

    workspaceResolvers[0]({ page: '1' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(getByTestId('workspace-page').textContent).toBe('2')
  })
})
