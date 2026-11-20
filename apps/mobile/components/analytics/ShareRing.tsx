// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A ring chart with a ranked legend beside it.
 *
 * Each caller owns its rows — label, value, share and colour — so one ring
 * draws token share per model (AI usage) and the OS split (Desktop versions)
 * without a second copy of the SVG geometry. Arc maths comes from
 * `shareRingSegments` (unit tested).
 */

import { View } from 'react-native'
import Svg, { Circle, G } from 'react-native-svg'
import { Text } from '../settings/account-sheet-chrome'
import { shareRingSegments } from '../../lib/engagement-utils'

export interface ShareRingRow {
  id: string
  label: string
  value: number
  /** Share of the ring, 0-100. Normalised again by `shareRingSegments`. */
  pct: number
  color: string
}

export function ShareRing({
  rows,
  size = 132,
  stroke = 18,
  formatValue,
  center,
}: {
  rows: ShareRingRow[]
  size?: number
  stroke?: number
  formatValue: (value: number) => string
  /** Text in the middle of the ring. Omitted when there is nothing to total. */
  center?: { value: string; caption: string }
}) {
  const radius = (size - stroke) / 2
  const segments = shareRingSegments(
    rows.map(({ id, pct }) => ({ id, pct })),
    radius,
  )
  if (segments.length === 0) return null
  const colorById = new Map(rows.map((row) => [row.id, row.color]))

  return (
    <View className="flex-row items-center gap-4 flex-wrap">
      <View style={{ width: size, height: size }} className="items-center justify-center">
        <Svg width={size} height={size}>
          {/* Start the first segment at 12 o'clock. */}
          <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke="#94a3b8"
              strokeOpacity={0.15}
              strokeWidth={stroke}
              fill="none"
            />
            {segments.map((seg) => (
              <Circle
                key={seg.id}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={colorById.get(seg.id) ?? '#94a3b8'}
                strokeWidth={stroke}
                strokeDasharray={`${seg.dash} ${seg.gap}`}
                strokeDashoffset={seg.offset}
              />
            ))}
          </G>
        </Svg>
        {center ? (
          <View className="absolute items-center">
            <Text className="text-base font-bold text-foreground">{center.value}</Text>
            <Text className="text-[10px] text-muted-foreground">{center.caption}</Text>
          </View>
        ) : null}
      </View>

      <View className="flex-1 min-w-[160px] gap-1.5">
        {rows.map((row) => (
          <View key={row.id} className="flex-row items-center gap-2">
            <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
            <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
              {row.label}
            </Text>
            <Text className="text-xs text-muted-foreground">{formatValue(row.value)}</Text>
            <Text className="text-xs font-medium text-foreground w-11 text-right">
              {row.pct.toFixed(1)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}
