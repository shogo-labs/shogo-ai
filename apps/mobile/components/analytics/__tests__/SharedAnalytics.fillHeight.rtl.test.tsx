// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Two chart cards side by side must end on the same edge.
 *
 * The Momentum row on /admin/analytics pairs Activity Trends (7 metric chips,
 * which wrap to their own line) with Active Users (3 chips, which sit inline
 * with the title). That made the left header 35px taller, so the two cards
 * ended at different heights. `fillHeight` lets the plot absorb the difference
 * instead of leaving a gap under the axis.
 *
 * These assertions run against the real `StackedAreaChart` (the preload stubs
 * `react-native-svg`), so they cover the plumbing end to end rather than
 * trusting a mock to echo a prop back.
 */

import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createRequire } from 'node:module'
import { createReactNativeMock } from '../../../test/react-native-mock'

const rnMock = createReactNativeMock({
  Pressable: ({ onPress, children, ...props }: any) =>
    createElement('button', { ...props, onClick: onPress }, children),
})
mock.module('react-native', () => rnMock)

const sharedRequire = createRequire(
  new URL('../../../../../packages/shared-ui/src/primitives/index.ts', import.meta.url),
)
mock.module(sharedRequire.resolve('react-native'), () => rnMock)

mock.module('../../lib/visible-models', () => ({
  resolveShortName: (id: string) => id,
  resolveFamily: () => 'other',
}))

const { MetricTrendChart, ActivityTrendsChart, ActiveUsersTrendChart } = await import(
  '../SharedAnalytics'
)

const days = [
  { date: '2026-07-06T00:00:00.000Z', values: { count: 3 } },
  { date: '2026-07-07T00:00:00.000Z', values: { count: 4 } },
]
const metrics = [{ id: 'count', label: 'Count', color: '#1' }]

const activityData = [
  {
    date: '2026-07-06T00:00:00.000Z',
    newUsers: 3,
    newWorkspaces: 1,
    newProjects: 2,
    messages: 10,
    sessions: 4,
    toolCalls: 6,
    activePayingSubscribers: 1,
  },
  {
    date: '2026-07-07T00:00:00.000Z',
    newUsers: 4,
    newWorkspaces: 1,
    newProjects: 3,
    messages: 12,
    sessions: 5,
    toolCalls: 7,
    activePayingSubscribers: 1,
  },
]
const activeUsersData = [
  { date: '2026-07-06T00:00:00.000Z', dau: 3, wau: 9, mau: 20 },
  { date: '2026-07-07T00:00:00.000Z', dau: 4, wau: 10, mau: 21 },
]

/**
 * The chart's own container — the element whose height the plot is drawn at.
 * Daily counts render bars, ratios render areas, so accept either.
 */
const chartBox = () => {
  const el =
    document.querySelector('[testid="stacked-chart-bar"]') ??
    document.querySelector('[testid="stacked-chart-area"]')
  if (!el) throw new Error('chart container not rendered')
  return el
}
const styleOf = (el: Element) => el.getAttribute('style') ?? ''
/** React DOM expands `flex: 1` into the three longhands. */
const FLEXES = 'flex-grow: 1'
/**
 * The hover overlay is drawn at the plot's height, so it reports the real box.
 * It is the parent of the per-day hit targets.
 */
const plotHeight = () => {
  const hit = document.querySelector('[testid="stacked-chart-hit-0"]')
  const overlay = hit?.parentElement
  if (!overlay) throw new Error('hit overlay not rendered')
  return /height:\s*([^;]+)/.exec(styleOf(overlay))?.[1]?.trim()
}

describe('chart fill height', () => {
  test('without fillHeight the plot keeps its fixed height and does not flex', () => {
    render(<MetricTrendChart title="T" days={days} metrics={metrics} height={240} />)
    const style = styleOf(chartBox())
    expect(style).not.toContain(FLEXES)
    expect(style).not.toContain('min-height')
    expect(plotHeight()).toBe('240px')
  })

  test('with fillHeight the plot flexes and keeps height as its floor', () => {
    render(<MetricTrendChart title="T" days={days} metrics={metrics} height={240} fillHeight />)
    const style = styleOf(chartBox())
    expect(style).toContain(FLEXES)
    expect(style).toContain('min-height: 240px')
    // Before the first layout pass the floor is what gets drawn.
    expect(plotHeight()).toBe('240px')
  })

  test('the loading placeholder flexes too, so the card does not jump when data lands', () => {
    const { container } = render(
      <MetricTrendChart title="T" days={days} metrics={metrics} height={240} fillHeight loading />,
    )
    // No chart while loading — the placeholder carries the flex instead.
    expect(document.querySelector('[testid="stacked-chart-bar"]')).toBeNull()
    expect(document.querySelector('[testid="stacked-chart-area"]')).toBeNull()
    const flexed = Array.from(container.querySelectorAll('[style]')).filter((el) => {
      const s = styleOf(el)
      return s.includes(FLEXES) && s.includes('min-height: 240px')
    })
    expect(flexed.length).toBeGreaterThan(0)
  })

  test('ActivityTrendsChart forwards fillHeight to the plot', () => {
    render(<ActivityTrendsChart data={activityData} fillHeight />)
    expect(styleOf(chartBox())).toContain(FLEXES)
  })

  test('ActiveUsersTrendChart forwards fillHeight to the plot', () => {
    render(<ActiveUsersTrendChart data={activeUsersData} fillHeight />)
    expect(styleOf(chartBox())).toContain(FLEXES)
  })

  test('ActivityTrendsChart stays fixed when fillHeight is off', () => {
    render(<ActivityTrendsChart data={activityData} />)
    expect(styleOf(chartBox())).not.toContain(FLEXES)
  })
})
