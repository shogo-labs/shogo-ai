// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Which chart variant each analytics surface asks for: daily counts are stacked
 * bars, cumulative totals and ratios stay areas/lines.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createRequire } from 'node:module'
import { createReactNativeMock } from '../../../test/react-native-mock'

const rnMock = createReactNativeMock({
  Pressable: ({ onPress, children, ...props }: any) =>
    createElement('button', { ...props, onClick: onPress }, children),
})
mock.module('react-native', () => rnMock)

// `@shogo/shared-ui` resolves `react-native` through its own node_modules link,
// so the preload's mock (keyed on the app's copy) misses it.
const sharedRequire = createRequire(
  new URL('../../../../../packages/shared-ui/src/primitives/index.ts', import.meta.url),
)
mock.module(sharedRequire.resolve('react-native'), () => rnMock)

mock.module('../../lib/visible-models', () => ({
  resolveShortName: (id: string) => id,
  resolveFamily: () => 'other',
}))

mock.module('../StackedAreaChart', () => ({
  STACKED_PALETTE: ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9'],
  StackedAreaChart: ({ variant }: any) =>
    createElement('div', { 'data-testid': 'stacked-chart', 'data-variant': variant ?? 'area' }),
}))

const {
  UsageTimeseriesChart,
  MetricTrendChart,
  ActiveUsersTrendChart,
  QualityTimeseriesChart,
  ActivityTrendsChart,
  PlatformGrowthChart,
} = await import('../SharedAnalytics')

const days = [
  { date: '2026-07-06T00:00:00.000Z', byModel: { m1: 0.4, m2: 0.6 } },
  { date: '2026-07-07T00:00:00.000Z', byModel: { m1: 0.5, m2: 0.5 } },
]
const spendData: any = {
  groupBy: 'model',
  models: ['m1', 'm2'],
  days,
  totals: { totalSpendUsd: 2, totalIncludedUsd: 2, totalOnDemandUsd: 0 },
}
const trendDays = [
  { date: '2026-07-06T00:00:00.000Z', values: { count: 3, rate: 0.5 } },
  { date: '2026-07-07T00:00:00.000Z', values: { count: 4, rate: 0.6 } },
]

const variantOf = () => screen.getByTestId('stacked-chart').getAttribute('data-variant')

describe('chart variants', () => {
  test('usage over time is bars in Daily and an area in Cumulative', () => {
    render(
      <UsageTimeseriesChart
        data={spendData}
        groupBy="model"
        metric="spend"
        onGroupByChange={() => {}}
        onMetricChange={() => {}}
        allowCumulative
      />,
    )
    expect(variantOf()).toBe('bar')

    fireEvent.click(screen.getByText('Cumulative'))
    expect(variantOf()).toBe('area')
  })

  test('activity counts and platform growth (daily) are bars', () => {
    render(
      <ActivityTrendsChart
        data={[
          {
            date: '2026-07-07',
            newUsers: 3,
            newWorkspaces: 1,
            newProjects: 2,
            messages: 40,
            sessions: 5,
            toolCalls: 90,
            activePayingSubscribers: 2,
          },
        ]}
      />,
    )
    expect(variantOf()).toBe('bar')
  })

  test('platform growth switches to an area when cumulative', () => {
    render(
      <PlatformGrowthChart
        data={[{ date: '2026-07-07', users: 3, workspaces: 1, projects: 2, sessions: 5 }]}
        totals={{ totalUsers: 100, totalWorkspaces: 10, totalProjects: 20, totalChatSessions: 50 }}
      />,
    )
    expect(variantOf()).toBe('bar')

    fireEvent.click(screen.getByText('Cumulative'))
    expect(variantOf()).toBe('area')
  })

  test('rolling active-user windows and quality ratios stay lines', () => {
    render(<ActiveUsersTrendChart data={[{ date: '2026-07-07', dau: 5, wau: 20, mau: 60 }]} />)
    expect(variantOf()).toBe('area')

    render(
      <QualityTimeseriesChart
        data={[
          {
            date: '2026-07-07',
            cacheHitRatio: 0.8,
            costPerMessage: 0.02,
            costPerActiveUser: 0.4,
            agentEscalatedRate: 0.1,
            agentLoopRate: 0.05,
            agentMaxTurnsRate: 0.02,
          },
        ]}
      />,
    )
    expect(screen.getAllByTestId('stacked-chart').every((el) => el.getAttribute('data-variant') === 'area')).toBe(true)
  })

  test('a single-metric trend honours kind: counts are bars, rates are lines', () => {
    render(
      <MetricTrendChart
        title="t"
        days={trendDays}
        metrics={[
          { id: 'count', label: 'Count' },
          { id: 'rate', label: 'Rate', kind: 'rate' },
        ]}
      />,
    )
    expect(variantOf()).toBe('bar')

    fireEvent.click(screen.getByText('Rate'))
    expect(variantOf()).toBe('area')
  })
})
