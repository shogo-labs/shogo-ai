// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `StackedAreaChart` bar variant: one rect per non-zero (day, series) segment,
 * stacked bottom-up so a day's segments fill its whole bar, and no hairlines on
 * empty days. Also pins the `area` default so untouched callers keep their
 * paths.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPressIn, children, ...props }: any) =>
      createElement(
        'button',
        {
          ...props,
          onClick: () => {
            onPressIn?.()
          },
        },
        children,
      ),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// Forward SVG props as data attributes so the geometry is assertable.
const svgPropNames = ['x', 'y', 'width', 'height', 'fill', 'd', 'cx', 'cy']
function svgStub(tag: string, displayName: string) {
  const C = ({ children, ...props }: any) => {
    const attrs: Record<string, unknown> = { 'data-svg': displayName }
    for (const name of svgPropNames) {
      if (props[name] !== undefined) attrs[`data-${name}`] = String(props[name])
    }
    return createElement(tag, attrs, children)
  }
  C.displayName = displayName
  return C
}
const Svg = svgStub('svg', 'Svg')
mock.module('react-native-svg', () => ({
  default: Svg,
  Svg,
  Rect: svgStub('div', 'Rect'),
  Path: svgStub('div', 'Path'),
  Circle: svgStub('div', 'Circle'),
  Line: svgStub('div', 'Line'),
  G: svgStub('div', 'G'),
  Defs: svgStub('div', 'Defs'),
  LinearGradient: svgStub('div', 'LinearGradient'),
  Stop: svgStub('div', 'Stop'),
  Text: svgStub('span', 'Text'),
}))

const { StackedAreaChart } = await import('../StackedAreaChart')

const series = [
  { id: 'a', label: 'Model A', color: '#111111' },
  { id: 'b', label: 'Model B', color: '#222222' },
]
// Day 0 is empty (must render no rect), day 1 has one series, day 2 both.
const days = [
  { date: '2026-07-05T00:00:00.000Z', values: { a: 0, b: 0 } },
  { date: '2026-07-06T00:00:00.000Z', values: { a: 10, b: 0 } },
  { date: '2026-07-07T00:00:00.000Z', values: { a: 10, b: 10 } },
]

const rects = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-svg="Rect"]')).map((el) => ({
    x: Number(el.getAttribute('data-x')),
    y: Number(el.getAttribute('data-y')),
    w: Number(el.getAttribute('data-width')),
    h: Number(el.getAttribute('data-height')),
    fill: el.getAttribute('data-fill'),
  }))

describe('StackedAreaChart bar variant', () => {
  test('one rect per non-zero (day, series) segment, stacked so they fill the bar', () => {
    // height 140 → innerH = 140 - 16 - 28 = 96; stack max 20 → niceMax 20.
    const { container } = render(
      <StackedAreaChart
        days={days}
        series={series}
        height={140}
        variant="bar"
        formatY={(n) => String(n)}
        formatTooltip={(n) => String(n)}
      />,
    )

    const bars = rects(container)
    // day 0 contributes nothing; day 1 one segment; day 2 two segments.
    expect(bars.length).toBe(3)
    expect(bars.map((b) => b.fill)).toEqual(['#111111', '#111111', '#222222'])

    // Day 1: single segment from 0 → 10 of a 20 max, so half the plot height.
    expect(bars[0].h).toBeCloseTo(48, 5)
    expect(bars[0].y).toBeCloseTo(64, 5)

    // Day 2: a (0→10) below b (10→20); together they span the full 96px stack.
    const day2 = bars.slice(1)
    expect(day2.map((b) => b.y)).toEqual([64, 16].map((v) => Math.round(v * 1e6) / 1e6))
    expect(day2.reduce((acc, b) => acc + b.h, 0)).toBeCloseTo(96, 5)

    // Every rect for the same day shares an x and a width.
    expect(day2[0].x).toBeCloseTo(day2[1].x, 6)
    expect(day2[0].w).toBeCloseTo(day2[1].w, 6)
    expect(day2[0].w).toBeLessThanOrEqual(28)
  })

  test('bars sit in equal slots and never overlap, even at 90 days on a phone', () => {
    const wide = Array.from({ length: 90 }, (_, i) => ({
      date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      values: { a: 1, b: 1 },
    }))
    const { container } = render(
      <StackedAreaChart days={wide} series={series} height={140} variant="bar" />,
    )
    const bars = rects(container)
    expect(bars.length).toBe(180)

    const day0 = bars.slice(0, 2)
    const day1 = bars.slice(2, 4)
    expect(day0[0].w).toBeGreaterThanOrEqual(2)
    // Right edge of day 0 stays left of day 1's left edge.
    expect(day0[0].x + day0[0].w).toBeLessThanOrEqual(day1[0].x)
  })

  test('the default variant still renders area paths and no bars', () => {
    const { container } = render(
      <StackedAreaChart days={days} series={series} height={140} />,
    )
    expect(rects(container).length).toBe(0)
    expect(container.querySelectorAll('[data-svg="Path"]').length).toBe(series.length)
  })

  test('a range with no data at all shows the empty state', () => {
    const { container } = render(
      <StackedAreaChart
        days={days.map((d) => ({ ...d, values: { a: 0, b: 0 } }))}
        series={series}
        variant="bar"
      />,
    )
    expect(screen.getByText('No usage data for this period')).toBeTruthy()
    expect(rects(container).length).toBe(0)
  })

  test('hovering a bar shows the date, the total, and the per-series breakdown', () => {
    render(
      <StackedAreaChart
        days={days}
        series={series}
        height={140}
        variant="bar"
        formatY={(n) => String(n)}
        formatTooltip={(n) => String(n)}
      />,
    )

    // One hit area per day, in day order.
    const hitAreas = screen.getAllByRole('button')
    expect(hitAreas.length).toBe(3)
    fireEvent.click(hitAreas[2])

    expect(screen.getByText(/Jul 7 · 20/)).toBeTruthy()
    expect(screen.getByText('Model A')).toBeTruthy()
    expect(screen.getByText('Model B')).toBeTruthy()
  })
})
