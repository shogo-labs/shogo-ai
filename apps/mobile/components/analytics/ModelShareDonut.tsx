// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ModelShareDonut
 *
 * Ring chart of token share per model with a ranked legend beside it, like
 * Z Code's "model usage" panel. Segment geometry comes from `donutSegments`
 * (unit tested); colours match the daily stacked chart so a model keeps one
 * colour across both.
 */

import { useMemo } from 'react'
import { View } from 'react-native'
import Svg, { Circle, G } from 'react-native-svg'
import { Text } from '../settings/account-sheet-chrome'
import { STACKED_PALETTE } from './StackedAreaChart'
import { compactNumber, donutSegments, seriesColor } from '../../lib/engagement-utils'

const SIZE = 132
const STROKE = 18
const RADIUS = (SIZE - STROKE) / 2

export interface ModelShareRow {
  model: string
  tokens: number
  pct: number
}

export function ModelShareDonut({ rows }: { rows: ModelShareRow[] }) {
  const segments = useMemo(() => donutSegments(rows, RADIUS), [rows])
  const total = useMemo(() => rows.reduce((s, r) => s + r.tokens, 0), [rows])

  if (segments.length === 0) {
    return (
      <View className="h-[132px] items-center justify-center">
        <Text className="text-sm text-muted-foreground">No model usage in this period</Text>
      </View>
    )
  }

  return (
    <View className="flex-row items-center gap-4 flex-wrap">
      <View style={{ width: SIZE, height: SIZE }} className="items-center justify-center">
        <Svg width={SIZE} height={SIZE}>
          {/* Start the first segment at 12 o'clock. */}
          <G rotation={-90} origin={`${SIZE / 2}, ${SIZE / 2}`}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke="#94a3b8" strokeOpacity={0.15} strokeWidth={STROKE} fill="none" />
            {segments.map((seg, i) => (
              <Circle
                key={seg.model}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={seriesColor(seg.model, i, STACKED_PALETTE)}
                strokeWidth={STROKE}
                strokeDasharray={`${seg.dash} ${seg.gap}`}
                strokeDashoffset={seg.offset}
              />
            ))}
          </G>
        </Svg>
        <View className="absolute items-center">
          <Text className="text-base font-bold text-foreground">{compactNumber(total)}</Text>
          <Text className="text-[10px] text-muted-foreground">tokens</Text>
        </View>
      </View>

      <View className="flex-1 min-w-[160px] gap-1.5">
        {rows.map((row, i) => (
          <View key={row.model} className="flex-row items-center gap-2">
            <View
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: seriesColor(row.model, i, STACKED_PALETTE) }}
            />
            <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
              {row.model}
            </Text>
            <Text className="text-xs text-muted-foreground">{compactNumber(row.tokens)}</Text>
            <Text className="text-xs font-medium text-foreground w-11 text-right">{row.pct.toFixed(1)}%</Text>
          </View>
        ))}
      </View>
    </View>
  )
}
