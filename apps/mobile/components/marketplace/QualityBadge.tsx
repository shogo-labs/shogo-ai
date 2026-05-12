// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text } from 'react-native'
import { ShieldCheck } from 'lucide-react-native'

interface QualityBadgeProps {
  /** Compact uses a tighter pill suitable for card overlays. */
  size?: 'sm' | 'md'
  /** Show only the icon (used inside dense card corners). */
  iconOnly?: boolean
  className?: string
}

/**
 * "Built for Shogo" — Shopify-style quality gate. Driven today by the
 * `featuredAt` timestamp on `MarketplaceListing`; can later be promoted
 * to a dedicated enum field. See plan P0 for the rationale.
 */
export function QualityBadge({ size = 'md', iconOnly = false, className }: QualityBadgeProps) {
  const iconSize = size === 'sm' ? 11 : 13
  if (iconOnly) {
    return (
      <View
        className={`rounded-full bg-primary/15 items-center justify-center ${
          size === 'sm' ? 'w-5 h-5' : 'w-6 h-6'
        } ${className ?? ''}`}
      >
        <ShieldCheck size={iconSize} color="#e27927" />
      </View>
    )
  }
  return (
    <View
      className={`flex-row items-center gap-1 rounded-full bg-primary/15 ${
        size === 'sm' ? 'px-1.5 py-0.5' : 'px-2 py-1'
      } ${className ?? ''}`}
    >
      <ShieldCheck size={iconSize} color="#e27927" />
      <Text
        className={`font-semibold text-primary ${
          size === 'sm' ? 'text-[10px]' : 'text-[11px]'
        }`}
      >
        Built for Shogo
      </Text>
    </View>
  )
}
