// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View } from 'react-native'
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg'

interface SparklineProps {
  /** Series of numeric values, oldest → newest. */
  data: number[]
  width?: number
  height?: number
  /** Stroke color. Defaults to brand orange. */
  stroke?: string
  /** When true, the area below the line is filled with a tinted gradient. */
  filled?: boolean
  className?: string
}

/**
 * Tiny no-axis sparkline — 100% Svg, no ticks/labels. Used inside stat
 * cards on the creator dashboard. Gracefully renders an empty stripe
 * when `data` is empty or all values are zero.
 */
export function Sparkline({
  data,
  width = 120,
  height = 36,
  stroke = '#e27927',
  filled = true,
  className,
}: SparklineProps) {
  if (data.length === 0) {
    return (
      <View
        className={className}
        style={{ width, height, backgroundColor: 'transparent' }}
      />
    )
  }
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const span = max - min || 1
  const stepX = data.length > 1 ? width / (data.length - 1) : width

  const points = data.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / span) * height
    return [x, y] as const
  })

  const pathD =
    points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
      .join(' ')

  const fillD = `${pathD} L ${width.toFixed(2)} ${height.toFixed(2)} L 0 ${height.toFixed(2)} Z`

  const gradientId = `spark-grad-${stroke.replace('#', '')}`

  return (
    <View className={className} style={{ width, height }}>
      <Svg width={width} height={height}>
        {filled && (
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={stroke} stopOpacity={0.25} />
              <Stop offset="1" stopColor={stroke} stopOpacity={0} />
            </LinearGradient>
          </Defs>
        )}
        {filled && <Path d={fillD} fill={`url(#${gradientId})`} />}
        <Path d={pathD} stroke={stroke} strokeWidth={1.5} fill="none" />
      </Svg>
    </View>
  )
}
