// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 — the admin home page loads each panel with its own request.
 *
 * It used to fire ten requests in one `Promise.all` whose dependency list held
 * `period`, `spendGroupBy` and `spendMetric`, so changing the spend chart's
 * grouping re-ran the overview, growth, usage summary and both install panels,
 * and nothing painted until the slowest of the ten returned. QA round 1 asked
 * for a request-count test on this page; this is it.
 *
 * The two infrastructure panels are `super_admin`-only, so the page is rendered
 * once as a super admin (ten requests) and once as a partial admin who can read
 * analytics but not infra (eight, and no infra request at all).
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
 * Native and fail the file before a single assertion runs.
 */
const sharedUiRequire = createRequire(
  resolvePath(import.meta.dir, '../../../../../packages/shared-ui/src/noop.js'),
)
mock.module('react-native', () => ReactNativeWeb)
mock.module(sharedUiRequire.resolve('react-native'), () => ReactNativeWeb)

mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}))

mock.module('../../../lib/native-phone-layout', () => ({
  isNativePlatform: () => false,
  nativeContentWidth: (w: number) => w,
  nativeTwoColumnCardWidth: (w: number) => w / 2,
}))

mock.module('../../../lib/api', () => ({ API_URL: 'http://api.test' }))

mock.module('../../../components/phone/SegmentedFilter', () => ({
  SegmentedFilter: () => null,
}))

mock.module('../../../components/analytics/AppVersionsPanel', () => ({
  AppVersionsPanel: () => null,
}))

mock.module('../../../components/analytics/ActiveDevicesPanel', () => ({
  ActiveDevicesPanel: () => null,
}))

mock.module('../../../components/analytics/SharedAnalytics', () => ({
  PlatformGrowthChart: () => null,
  ActiveUsersTrendChart: () => null,
  // The real chart owns the group-by/metric switch that changes `spendGroupBy`.
  UsageTimeseriesChart: ({ onGroupByChange }: any) => (
    <button data-testid="spend-group" onClick={() => onGroupByChange('provider')}>
      provider
    </button>
  ),
}))

let role = 'super_admin'
const paths: string[] = []

const jsonResponse = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response

/**
 * Just enough of each payload for the page's own presentational components to
 * render: they read `totals.active.d1` and `totals.newLast30d` without a guard.
 */
const payload = (path: string): unknown => {
  if (path === '/analytics/active-users') return { dau: 1, wau: 2, mau: 3 }
  if (path === '/analytics/devices') {
    const active = { d1: 1, d7: 1, d30: 1 }
    return { totals: { totalDevices: 1, active, newLast30d: 0, distinctUsers: 1 }, byVersion: [], byPlatform: [] }
  }
  if (path === '/analytics/app-installs') {
    const segment = {
      total: 1,
      totalDevices: 1,
      newLast30d: 0,
      active: { d1: 1, d7: 1, d30: 1 },
      byVersion: [],
      byPlatform: [],
    }
    const totals = { totalDevices: 1, active: { d1: 1, d7: 1, d30: 1 }, newLast30d: 0, distinctUsers: 1 }
    return { desktop: segment, cli: null, ios: segment, android: segment, totals }
  }
  if (path === '/analytics/infra-current') return { live: null, snapshot: null }
  // These three panels render a chart straight off the array.
  if (path === '/analytics/infra-history') return []
  if (path === '/analytics/growth') return []
  if (path === '/analytics/active-users-timeseries') return []
  return {}
}

beforeEach(() => {
  role = 'super_admin'
  paths.length = 0
  ;(globalThis as any).fetch = async (input: string) => {
    const url = new URL(String(input), 'http://api.test')
    if (url.pathname === '/api/me') return jsonResponse({ data: { role } })
    const path = url.pathname.replace('/api/admin', '')
    paths.push(path + (url.search || ''))
    return jsonResponse({ data: payload(path) })
  }
})

afterEach(cleanup)

// Exact path, ignoring the query: `/analytics/active-users` is a prefix of
// `/analytics/active-users-timeseries` and must not count that panel.
const callsFor = (path: string) => paths.filter((p) => p.split('?')[0] === path).length

const { default: AdminHomePage } = await import('../index')

describe('admin home page', () => {
  test('a super admin loads each panel once, including the two infra panels', async () => {
    render(<AdminHomePage />)

    await waitFor(() => expect(paths).toHaveLength(10))
    for (const path of [
      '/analytics/overview',
      '/analytics/active-users',
      '/analytics/app-installs',
      '/analytics/devices',
      '/analytics/growth',
      '/analytics/usage-summary',
      '/analytics/active-users-timeseries',
      '/analytics/spend-timeseries',
      '/analytics/infra-current',
      '/analytics/infra-history',
    ]) {
      expect(callsFor(path)).toBe(1)
    }
  })

  test('a partial admin never requests the infra panels', async () => {
    role = 'admin'
    render(<AdminHomePage />)

    await waitFor(() => expect(paths).toHaveLength(8))
    expect(callsFor('/analytics/infra-current')).toBe(0)
    expect(callsFor('/analytics/infra-history')).toBe(0)
  })

  test('changing the spend grouping refetches only the spend panel', async () => {
    const { getByTestId } = render(<AdminHomePage />)
    await waitFor(() => expect(paths).toHaveLength(10))

    fireEvent.click(getByTestId('spend-group'))
    await waitFor(() => expect(callsFor('/analytics/spend-timeseries')).toBe(2))

    expect(paths).toHaveLength(11)
    expect(callsFor('/analytics/overview')).toBe(1)
    expect(callsFor('/analytics/growth')).toBe(1)
    expect(callsFor('/analytics/usage-summary')).toBe(1)
    expect(callsFor('/analytics/infra-current')).toBe(1)
    expect(paths.filter((p) => p.split('?')[0] === '/analytics/spend-timeseries').at(-1)).toContain(
      'groupBy=provider',
    )
  })
})
