// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Pressable } from 'react-native'
import { Star } from 'lucide-react-native'

interface StarRatingProps {
  /** Rating value from 0 to 5. Half-stars are rendered when fractional. */
  rating: number
  /** Star pixel size. */
  size?: number
  /** When provided, stars become tappable selectors used by review forms. */
  onChange?: (rating: number) => void
  /** Spacing between stars in pixels. Defaults to 2. */
  gap?: number
}

const FILLED = '#eab308'
const EMPTY_LIGHT = '#d1d5db'
const EMPTY_DARK = '#3f3f46'

/**
 * Single source of truth for stars across the marketplace. Replaces the
 * inline `renderStars` helpers that were duplicated in the listing detail
 * page and in `ReviewCard`.
 *
 * - Read-only mode (no `onChange`): renders 5 stars with half-star
 *   precision driven by `rating`.
 * - Editable mode (`onChange` provided): each star is a tap target that
 *   calls back with values 1..5.
 */
export function StarRating({ rating, size = 14, onChange, gap = 2 }: StarRatingProps) {
  const isEditable = typeof onChange === 'function'
  const full = Math.floor(rating)
  const half = !isEditable && rating - full >= 0.5

  return (
    <View className="flex-row items-center" style={{ gap }}>
      {[0, 1, 2, 3, 4].map((i) => {
        const filled = isEditable
          ? i < Math.round(rating)
          : i < full || (i === full && half)
        const color = filled ? FILLED : EMPTY_LIGHT
        const node = (
          <Star
            key={i}
            size={size}
            fill={filled ? FILLED : 'transparent'}
            color={color}
          />
        )
        if (!isEditable) return node
        return (
          <Pressable key={i} onPress={() => onChange!(i + 1)} hitSlop={4}>
            {node}
          </Pressable>
        )
      })}
    </View>
  )
}

export { FILLED as STAR_FILLED, EMPTY_LIGHT as STAR_EMPTY, EMPTY_DARK as STAR_EMPTY_DARK }
