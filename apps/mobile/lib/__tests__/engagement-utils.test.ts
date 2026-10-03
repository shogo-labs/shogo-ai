// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  buildHeatmapGrid,
  compactNumber,
  donutSegments,
  formatHourLabel,
  formatLastActive,
  heatLevel,
  pluralDays,
  seriesColor,
  weekdayOf,
} from '../engagement-utils'

const cell = (date: string, count = 0) => ({ date, count, tokens: 0 })

describe('formatting', () => {
  test('compactNumber', () => {
    expect(compactNumber(0)).toBe('0')
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1_234)).toBe('1.2K')
    expect(compactNumber(45_600)).toBe('46K')
    expect(compactNumber(2_500_000)).toBe('2.5M')
    expect(compactNumber(3_100_000_000)).toBe('3.1B')
    expect(compactNumber(undefined)).toBe('0')
    expect(compactNumber(NaN)).toBe('0')
  })

  test('formatHourLabel handles midnight, noon and bad input', () => {
    expect(formatHourLabel(0)).toBe('12 AM')
    expect(formatHourLabel(9)).toBe('9 AM')
    expect(formatHourLabel(12)).toBe('12 PM')
    expect(formatHourLabel(13)).toBe('1 PM')
    expect(formatHourLabel(23)).toBe('11 PM')
    expect(formatHourLabel(null)).toBe('—')
    expect(formatHourLabel(24)).toBe('—')
  })

  test('pluralDays', () => {
    expect(pluralDays(1)).toBe('1 day')
    expect(pluralDays(0)).toBe('0 days')
    expect(pluralDays(12)).toBe('12 days')
  })

  test('formatLastActive compares calendar days', () => {
    const now = new Date(2026, 6, 10, 15, 0, 0)
    expect(formatLastActive(null, now)).toBe('No activity')
    expect(formatLastActive(new Date(2026, 6, 10, 1, 0, 0).toISOString(), now)).toBe('Today')
    expect(formatLastActive(new Date(2026, 6, 9, 23, 0, 0).toISOString(), now)).toBe('Yesterday')
    expect(formatLastActive(new Date(2026, 6, 7, 12, 0, 0).toISOString(), now)).toBe('3d ago')
    expect(formatLastActive('garbage', now)).toBe('—')
  })
})

describe('heatmap grid', () => {
  test('2026-07-01 is a Wednesday', () => {
    expect(weekdayOf('2026-07-01')).toBe(3)
    expect(weekdayOf('2026-07-05')).toBe(0)
  })

  test('pads the first week so days land on the right row', () => {
    const grid = buildHeatmapGrid([cell('2026-07-01', 2), cell('2026-07-02', 5), cell('2026-07-03'), cell('2026-07-04'), cell('2026-07-05', 1)])
    // Wed..Sat fill the first column after three leading blanks; Sunday starts a new one.
    expect(grid.weeks).toHaveLength(2)
    expect(grid.weeks[0].slice(0, 3)).toEqual([null, null, null])
    expect(grid.weeks[0][3]?.date).toBe('2026-07-01')
    expect(grid.weeks[0][6]?.date).toBe('2026-07-04')
    expect(grid.weeks[1][0]?.date).toBe('2026-07-05')
    expect(grid.weeks[1].slice(1)).toEqual([null, null, null, null, null, null])
    expect(grid.max).toBe(5)
  })

  test('every column has seven rows', () => {
    const cells = Array.from({ length: 40 }, (_, i) => cell(`2026-07-${String((i % 28) + 1).padStart(2, '0')}`))
    const grid = buildHeatmapGrid(cells)
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true)
  })

  test('labels each month once at the column where it starts', () => {
    const cells: ReturnType<typeof cell>[] = []
    for (let d = 1; d <= 31; d++) cells.push(cell(`2026-07-${String(d).padStart(2, '0')}`))
    for (let d = 1; d <= 10; d++) cells.push(cell(`2026-08-${String(d).padStart(2, '0')}`))
    const grid = buildHeatmapGrid(cells)
    expect(grid.monthLabels.map((m) => m.label)).toEqual(['Jul', 'Aug'])
    expect(grid.monthLabels[0].week).toBe(0)
    expect(grid.monthLabels[1].week).toBeGreaterThan(1)
  })

  test('a sliver of a leading month does not collide with the next label', () => {
    // Jul 28 (Tue) to Aug 10: July only fills the first few cells of column 0.
    const cells: ReturnType<typeof cell>[] = []
    for (let d = 28; d <= 31; d++) cells.push(cell(`2026-07-${d}`))
    for (let d = 1; d <= 10; d++) cells.push(cell(`2026-08-${String(d).padStart(2, '0')}`))
    const grid = buildHeatmapGrid(cells)
    expect(grid.monthLabels).toEqual([{ week: 0, label: 'Aug' }])
  })

  test('empty input', () => {
    expect(buildHeatmapGrid([])).toEqual({ weeks: [], max: 0, monthLabels: [] })
  })

  test('heatLevel scales against the busiest day and never shows quiet days as empty', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(1, 100)).toBe(1)
    expect(heatLevel(50, 100)).toBe(2)
    expect(heatLevel(75, 100)).toBe(3)
    expect(heatLevel(100, 100)).toBe(4)
    expect(heatLevel(5, 0)).toBe(0)
  })
})

describe('donut', () => {
  test('segments fill the circle exactly and start where the previous ended', () => {
    const r = 40
    const circ = 2 * Math.PI * r
    const segs = donutSegments(
      [{ model: 'a', pct: 50 }, { model: 'b', pct: 30 }, { model: 'c', pct: 20 }],
      r,
    )
    expect(segs.map((s) => s.dash).reduce((a, b) => a + b, 0)).toBeCloseTo(circ, 6)
    expect(segs[0].offset).toBeCloseTo(0, 6)
    expect(segs[1].offset).toBeCloseTo(-segs[0].dash, 6)
    expect(segs[2].offset).toBeCloseTo(-(segs[0].dash + segs[1].dash), 6)
    for (const s of segs) expect(s.dash + s.gap).toBeCloseTo(circ, 6)
  })

  test('rounded percentages that do not sum to 100 are normalised', () => {
    const segs = donutSegments([{ model: 'a', pct: 33.3 }, { model: 'b', pct: 33.3 }, { model: 'c', pct: 33.3 }], 10)
    expect(segs.reduce((s, x) => s + x.dash, 0)).toBeCloseTo(2 * Math.PI * 10, 6)
  })

  test('no data gives no segments', () => {
    expect(donutSegments([], 10)).toEqual([])
    expect(donutSegments([{ model: 'a', pct: 0 }], 10)).toEqual([])
  })

  test('seriesColor keeps Other neutral and cycles the palette without using the neutral slot', () => {
    const palette = ['#1', '#2', '#3', '#slate']
    expect(seriesColor('Other', 0, palette)).toBe('#94a3b8')
    expect(seriesColor('x', 0, palette)).toBe('#1')
    expect(seriesColor('x', 3, palette)).toBe('#1')
  })
})
