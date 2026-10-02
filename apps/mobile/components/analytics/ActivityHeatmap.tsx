// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ActivityHeatmap + HourOfWeekGrid
 *
 * `ActivityHeatmap` is a GitHub-style calendar: one column per week, one row
 * per weekday, shaded by how much a person did that day. Tap (or click) a cell
 * to read its exact numbers underneath — that works the same on web and
 * native, where there is no hover.
 *
 * `HourOfWeekGrid` is the "when do you work" companion: 7 weekday rows by
 * 24 hour columns.
 *
 * Pure react-native-svg, same approach as `StackedAreaChart`. Layout math lives
 * in `lib/engagement-utils.ts` so it is unit tested.
 */

import { useMemo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import Svg, { G, Rect, Text as SvgText } from 'react-native-svg'
import { Text } from '../settings/account-sheet-chrome'
import {
  buildHeatmapGrid,
  compactNumber,
  formatHourLabel,
  heatLevel,
  type HeatmapCell,
} from '../../lib/engagement-utils'

const CELL = 12
const GAP = 3
const STEP = CELL + GAP
const LEFT = 28
const TOP = 16
const MUTED = '#94a3b8'
const ACCENT = '#10b981'
/** Opacity per intensity level 0..4 (level 0 uses the muted colour). */
const LEVEL_OPACITY = [0.16, 0.35, 0.55, 0.78, 1] as const
const WEEKDAY_ROWS: { row: number; label: string }[] = [
  { row: 1, label: 'Mon' },
  { row: 3, label: 'Wed' },
  { row: 5, label: 'Fri' },
]

function levelFill(level: 0 | 1 | 2 | 3 | 4) {
  return { fill: level === 0 ? MUTED : ACCENT, fillOpacity: LEVEL_OPACITY[level] }
}

function formatDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function Legend() {
  return (
    <View className="flex-row items-center gap-1">
      <Text className="text-[10px] text-muted-foreground mr-1">Less</Text>
      <Svg width={5 * STEP} height={CELL}>
        {([0, 1, 2, 3, 4] as const).map((l) => (
          <Rect key={l} x={l * STEP} y={0} width={CELL} height={CELL} rx={3} {...levelFill(l)} />
        ))}
      </Svg>
      <Text className="text-[10px] text-muted-foreground ml-1">More</Text>
    </View>
  )
}

export function ActivityHeatmap({ cells }: { cells: HeatmapCell[] }) {
  const grid = useMemo(() => buildHeatmapGrid(cells), [cells])
  const [selected, setSelected] = useState<string | null>(null)
  const scrollRef = useRef<ScrollView>(null)

  const width = LEFT + grid.weeks.length * STEP
  const height = TOP + 7 * STEP
  const picked = selected ? cells.find((c) => c.date === selected) : null

  return (
    <View className="gap-2">
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        // Long ranges overflow; start at the most recent week.
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <Svg width={width} height={height}>
          {grid.monthLabels.map((m) => (
            <SvgText key={`${m.week}-${m.label}`} x={LEFT + m.week * STEP} y={10} fontSize={10} fill={MUTED}>
              {m.label}
            </SvgText>
          ))}
          {WEEKDAY_ROWS.map(({ row, label }) => (
            <SvgText key={label} x={0} y={TOP + row * STEP + CELL - 2} fontSize={9} fill={MUTED}>
              {label}
            </SvgText>
          ))}
          {grid.weeks.map((week, w) =>
            week.map((cell, row) => {
              if (!cell) return null
              const isSelected = cell.date === selected
              return (
                <Rect
                  key={cell.date}
                  x={LEFT + w * STEP}
                  y={TOP + row * STEP}
                  width={CELL}
                  height={CELL}
                  rx={3}
                  {...levelFill(heatLevel(cell.count, grid.max))}
                  stroke={isSelected ? ACCENT : 'none'}
                  strokeWidth={isSelected ? 1.5 : 0}
                  onPress={() => setSelected(isSelected ? null : cell.date)}
                />
              )
            }),
          )}
        </Svg>
      </ScrollView>

      <View className="flex-row items-center justify-between flex-wrap gap-2">
        <Text className="text-xs text-muted-foreground flex-1 min-w-[160px]">
          {picked
            ? `${formatDay(picked.date)} · ${picked.count} ${picked.count === 1 ? 'action' : 'actions'}${
                picked.tokens > 0 ? ` · ${compactNumber(picked.tokens)} tokens` : ''
              }`
            : 'Tap a day for details'}
        </Text>
        <Legend />
      </View>
    </View>
  )
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOUR_CELL = 11
const HOUR_GAP = 2
const HOUR_STEP = HOUR_CELL + HOUR_GAP

export function HourOfWeekGrid({ matrix }: { matrix: number[][] }) {
  const max = useMemo(() => Math.max(0, ...matrix.map((row) => Math.max(0, ...row))), [matrix])
  const width = LEFT + 24 * HOUR_STEP
  const height = 12 + 7 * HOUR_STEP + 12

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Svg width={width} height={height}>
        {[0, 6, 12, 18].map((h) => (
          <SvgText key={h} x={LEFT + h * HOUR_STEP} y={9} fontSize={9} fill={MUTED}>
            {formatHourLabel(h)}
          </SvgText>
        ))}
        {matrix.map((row, d) => (
          <G key={DOW[d]}>
            <SvgText x={0} y={12 + d * HOUR_STEP + HOUR_CELL - 2} fontSize={9} fill={MUTED}>
              {DOW[d]}
            </SvgText>
            {row.map((count, h) => (
              <Rect
                key={h}
                x={LEFT + h * HOUR_STEP}
                y={12 + d * HOUR_STEP}
                width={HOUR_CELL}
                height={HOUR_CELL}
                rx={2}
                {...levelFill(heatLevel(count, max))}
              />
            ))}
          </G>
        ))}
      </Svg>
    </ScrollView>
  )
}
