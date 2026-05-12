// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { ScrollView, View } from 'react-native'

interface HorizontalRailProps<T> {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  keyExtractor: (item: T, index: number) => string
  /** Width of each item (px). Used to compute snap intervals. */
  itemWidth?: number
  /** Horizontal padding between items in pixels. */
  gap?: number
  /** Outer horizontal padding so the first/last card aligns with section content. */
  contentPadding?: number
  /** Test ID forwarded to the underlying ScrollView. */
  testID?: string
}

/**
 * Generic horizontal rail used by every marketplace collection. Wraps a
 * `ScrollView` with snap, sane padding, and a fixed-width column. Items
 * keep their own internal layout — the rail just lays them out.
 *
 * Note: we intentionally use `ScrollView` rather than `FlatList` because
 * collection sizes are small (≤ 8) and `FlatList` adds layout overhead
 * for marginal benefit at this scale.
 */
export function HorizontalRail<T>({
  items,
  renderItem,
  keyExtractor,
  itemWidth = 240,
  gap = 12,
  contentPadding = 20,
  testID,
}: HorizontalRailProps<T>) {
  if (items.length === 0) return null
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={itemWidth + gap}
      snapToAlignment="start"
      contentContainerStyle={{ paddingHorizontal: contentPadding, gap }}
      testID={testID}
    >
      {items.map((item, index) => (
        <View key={keyExtractor(item, index)} style={{ width: itemWidth }}>
          {renderItem(item, index)}
        </View>
      ))}
    </ScrollView>
  )
}
