// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, useWindowDimensions, type ViewStyle } from 'react-native'
import { nativeGridChipWidth } from '../lib/native-phone-layout'

/** Marketplace grid FlatList `paddingHorizontal` on each side. */
export const MARKETPLACE_GRID_PAD_X = 12
/** Left + right marketplace grid padding. */
export const MARKETPLACE_GRID_H_PADDING = MARKETPLACE_GRID_PAD_X * 2

const GRID_TWO_COL_MIN_WIDTH = 480
const GRID_THREE_COL_MIN_WIDTH = 768
const GRID_FOUR_COL_MIN_WIDTH = 1080

/**
 * Column count for the marketplace grid at a given window width.
 *
 *   <  480px  →  1 column   (phones, narrow web)
 *   <  768px  →  2 columns  (foldables, small tablets)
 *   < 1080px  →  3 columns  (tablets, narrow desktop)
 *   >= 1080px →  4 columns  (full desktop)
 */
export function marketplaceGridColumns(width: number): 1 | 2 | 3 | 4 {
  if (width < GRID_TWO_COL_MIN_WIDTH) return 1
  if (width < GRID_THREE_COL_MIN_WIDTH) return 2
  if (width < GRID_FOUR_COL_MIN_WIDTH) return 3
  return 4
}

export function useGridColumns(): 1 | 2 | 3 | 4 {
  const { width } = useWindowDimensions()
  return marketplaceGridColumns(width)
}

/**
 * Native Yoga cannot size `flex-1` / `%` cards inside a FlatList, so each
 * cell gets a pixel width. Web keeps the existing flex layout.
 */
export function useMarketplaceGridLayout(): {
  numColumns: 1 | 2 | 3 | 4
  cardWidth?: number
  cellStyle?: ViewStyle
} {
  const { width } = useWindowDimensions()
  const numColumns = marketplaceGridColumns(width)
  if (Platform.OS === 'web') return { numColumns }
  const cardWidth = nativeGridChipWidth(
    Math.max(0, width - MARKETPLACE_GRID_H_PADDING),
    numColumns,
    0,
  )
  return {
    numColumns,
    cardWidth,
    cellStyle: { width: cardWidth, maxWidth: cardWidth },
  }
}

/** `flex-1` only when the cell is not already pinned to a pixel width. */
export function marketplaceGridCellClass(cellStyle?: ViewStyle): string | undefined {
  return cellStyle ? undefined : 'flex-1'
}
