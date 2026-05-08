// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * StackedAreaChart
 *
 * A pure react-native-svg cumulative stacked-area chart used by the workspace
 * Usage tab. Series share a fixed palette so colors stay stable across renders.
 *
 * Inputs are intentionally simple — the caller decides series order, labels,
 * and which key inside each `day.values` map corresponds to which series.
 */

import { useMemo, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import Svg, {
  Path,
  Defs,
  LinearGradient,
  Stop,
  Line,
  Text as SvgText,
  Circle,
  G,
} from 'react-native-svg'
import { cn } from '@shogo/shared-ui/primitives'

export interface StackedDay {
  date: string
  values: Record<string, number>
}

export interface StackedSeries {
  id: string
  label: string
  color: string
}

export interface StackedAreaChartProps {
  days: StackedDay[]
  series: StackedSeries[]
  height?: number
  /** Pre-formatted axis label, e.g. `$1,000` or `1.2K`. */
  formatY?: (n: number) => string
  /** Pre-formatted tooltip value, e.g. `$1,234.56`. */
  formatTooltip?: (n: number) => string
  /** Render a "Today" caret on the rightmost x-tick when true. */
  markToday?: boolean
}

/** Default palette tuned to read well on dark and light backgrounds. */
export const STACKED_PALETTE = [
  '#10b981', // emerald (claude-opus-4-7-thinking-xhigh in screenshot)
  '#3b82f6', // blue   (claude-opus-4-7-thinking-high)
  '#22c55e', // green  (gpt-5.5-medium)
  '#a855f7', // purple (claude-4.6-opus-high)
  '#14b8a6', // teal
  '#f97316', // orange
  '#ef4444', // red
  '#eab308', // yellow
  '#94a3b8', // slate (Other)
]

const PADDING = { top: 16, right: 32, bottom: 28, left: 56 }

function defaultFormatY(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  if (n >= 1) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

function defaultFormatTooltip(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function formatTick(date: string): string {
  const d = new Date(date)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function StackedAreaChart({
  days,
  series,
  height = 260,
  formatY = defaultFormatY,
  formatTooltip = defaultFormatTooltip,
  markToday = true,
}: StackedAreaChartProps) {
  const [width, setWidth] = useState(720)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const innerW = Math.max(0, width - PADDING.left - PADDING.right)
  const innerH = Math.max(0, height - PADDING.top - PADDING.bottom)

  const { stacked, yMax } = useMemo(() => {
    let max = 0
    const cumulative = days.map((d) => {
      const acc: Record<string, { from: number; to: number }> = {}
      let running = 0
      for (const s of series) {
        const v = Math.max(0, d.values[s.id] ?? 0)
        acc[s.id] = { from: running, to: running + v }
        running += v
      }
      max = Math.max(max, running)
      return acc
    })
    return { stacked: cumulative, yMax: max }
  }, [days, series])

  const niceMax = useMemo(() => {
    if (yMax === 0) return 1
    const exp = Math.pow(10, Math.floor(Math.log10(yMax)))
    const candidates = [1, 2, 2.5, 5, 10].map((c) => c * exp)
    return candidates.find((c) => c >= yMax) ?? yMax
  }, [yMax])

  if (days.length === 0 || yMax === 0) {
    return (
      <View
        className="rounded-xl border border-border bg-card items-center justify-center"
        style={{ height }}
      >
        <Text className="text-sm text-muted-foreground">No usage data for this period</Text>
        {days.length > 0 && yMax === 0 && (
          <Text className="text-xs text-muted-foreground mt-1">
            Try a different metric or date range
          </Text>
        )}
      </View>
    )
  }

  const stepX = days.length > 1 ? innerW / (days.length - 1) : innerW

  function xFor(i: number): number {
    return PADDING.left + i * stepX
  }
  function yFor(v: number): number {
    return PADDING.top + innerH - (v / niceMax) * innerH
  }

  // Build smooth area paths bottom-up
  const areaPaths = series.map((s) => {
    const top = days.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(2)} ${yFor(stacked[i][s.id].to).toFixed(2)}`).join(' ')
    const bottom = days
      .map((_, i) => `L ${xFor(days.length - 1 - i).toFixed(2)} ${yFor(stacked[days.length - 1 - i][s.id].from).toFixed(2)}`)
      .join(' ')
    return `${top} ${bottom} Z`
  })

  // Y-axis ticks (4)
  const yTicks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax]

  // X-axis ticks: aim for 6 evenly-spaced labels
  const xTickCount = Math.min(6, days.length)
  const xTickIdxs: number[] = []
  for (let i = 0; i < xTickCount; i++) {
    xTickIdxs.push(Math.round((i / Math.max(1, xTickCount - 1)) * (days.length - 1)))
  }

  const todayIdx = days.length - 1
  const hover = hoverIdx != null ? days[hoverIdx] : null
  const hoverTotal = hover
    ? series.reduce((s, sr) => s + (hover.values[sr.id] ?? 0), 0)
    : 0

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ width: '100%' }}
    >
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        <Defs>
          {series.map((s) => (
            <LinearGradient
              key={`grad-${s.id}`}
              id={`grad-${s.id.replace(/[^a-z0-9]/gi, '_')}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <Stop offset="0" stopColor={s.color} stopOpacity={0.7} />
              <Stop offset="1" stopColor={s.color} stopOpacity={0.15} />
            </LinearGradient>
          ))}
        </Defs>

        {/* Y gridlines + tick labels */}
        {yTicks.map((t, i) => (
          <G key={`yt-${i}`}>
            <Line
              x1={PADDING.left}
              x2={PADDING.left + innerW}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke="#94a3b8"
              strokeOpacity={0.18}
              strokeWidth={1}
            />
            <SvgText
              x={PADDING.left - 8}
              y={yFor(t) + 4}
              fontSize={10}
              fill="#94a3b8"
              textAnchor="end"
            >
              {formatY(t)}
            </SvgText>
          </G>
        ))}

        {/* Stacked areas */}
        {series.map((s, i) => (
          <Path
            key={s.id}
            d={areaPaths[i]}
            fill={`url(#grad-${s.id.replace(/[^a-z0-9]/gi, '_')})`}
            stroke={s.color}
            strokeWidth={1}
          />
        ))}

        {/* X-axis labels */}
        {xTickIdxs.map((idx) => (
          <SvgText
            key={`xt-${idx}`}
            x={xFor(idx)}
            y={PADDING.top + innerH + 18}
            fontSize={10}
            fill="#94a3b8"
            textAnchor="middle"
          >
            {formatTick(days[idx].date)}
          </SvgText>
        ))}

        {/* Today caret */}
        {markToday && days.length > 1 && (
          <G>
            <Line
              x1={xFor(todayIdx)}
              x2={xFor(todayIdx)}
              y1={PADDING.top}
              y2={PADDING.top + innerH}
              stroke="#94a3b8"
              strokeOpacity={0.4}
              strokeDasharray="3,3"
              strokeWidth={1}
            />
            <SvgText
              x={xFor(todayIdx)}
              y={PADDING.top - 4}
              fontSize={10}
              fill="#94a3b8"
              textAnchor="middle"
            >
              Today
            </SvgText>
          </G>
        )}

        {/* Hover marker */}
        {hover != null && hoverIdx != null && (
          <G>
            <Line
              x1={xFor(hoverIdx)}
              x2={xFor(hoverIdx)}
              y1={PADDING.top}
              y2={PADDING.top + innerH}
              stroke="#94a3b8"
              strokeOpacity={0.6}
              strokeWidth={1}
            />
            <Circle
              cx={xFor(hoverIdx)}
              cy={yFor(hoverTotal)}
              r={4}
              fill="#fff"
              stroke="#0f172a"
              strokeWidth={1.5}
            />
          </G>
        )}
      </Svg>

      {/* Hover hit-areas — overlay invisible pressables for desktop hover/touch */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: 0,
          left: PADDING.left,
          right: PADDING.right,
          height,
          flexDirection: 'row',
        }}
      >
        {days.map((_, i) => (
          <Pressable
            key={`hit-${i}`}
            onHoverIn={() => setHoverIdx(i)}
            onHoverOut={() => setHoverIdx(null)}
            onPressIn={() => setHoverIdx(i)}
            onPressOut={() => setHoverIdx(null)}
            style={{ flex: 1, height: '100%' }}
          />
        ))}
      </View>

      {/* Tooltip */}
      {hover && (
        <View
          className="absolute rounded-md border border-border bg-popover px-3 py-2 shadow-lg"
          style={{
            top: PADDING.top + 4,
            left: Math.min(
              Math.max(PADDING.left + 8, xFor(hoverIdx ?? 0) - 80),
              width - 192,
            ),
            minWidth: 184,
          }}
        >
          <Text className="text-[11px] font-medium text-foreground mb-1">
            {formatTick(hover.date)} · {formatTooltip(hoverTotal)}
          </Text>
          {series
            .map((s) => ({ s, v: hover.values[s.id] ?? 0 }))
            .filter((r) => r.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 6)
            .map(({ s, v }) => (
              <View key={s.id} className="flex-row items-center gap-1.5">
                <View
                  style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }}
                />
                <Text className="text-[10px] text-muted-foreground flex-1" numberOfLines={1}>
                  {s.label}
                </Text>
                <Text className="text-[10px] font-mono text-foreground">{formatTooltip(v)}</Text>
              </View>
            ))}
        </View>
      )}
    </View>
  )
}

/**
 * Legend chips rendered below the chart. Series order matches the chart's
 * z-order (top of stack last).
 */
export function StackedAreaLegend({
  series,
  className,
}: {
  series: StackedSeries[]
  className?: string
}) {
  return (
    <View className={cn('flex-row flex-wrap gap-x-4 gap-y-1.5', className)}>
      {series.map((s) => (
        <View key={s.id} className="flex-row items-center gap-1.5">
          <View
            style={{ width: 12, height: 4, borderRadius: 2, backgroundColor: s.color }}
          />
          <Text className="text-[11px] text-muted-foreground">{s.label}</Text>
        </View>
      ))}
    </View>
  )
}
