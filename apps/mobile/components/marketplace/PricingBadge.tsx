// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text } from 'react-native'

interface PricingBadgeProps {
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
}

function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

const BADGE_STYLES = {
  free: 'bg-emerald-500/15',
  one_time: 'bg-blue-500/15',
  subscription: 'bg-purple-500/15',
} as const

const TEXT_STYLES = {
  free: 'text-emerald-600',
  one_time: 'text-blue-600',
  subscription: 'text-purple-600',
} as const

export function PricingBadge({ pricingModel, priceInCents, monthlyPriceInCents }: PricingBadgeProps) {
  let label: string
  if (pricingModel === 'free') {
    label = 'Free'
  } else if (pricingModel === 'subscription' && monthlyPriceInCents) {
    label = `${formatCents(monthlyPriceInCents)}/mo`
  } else if (priceInCents) {
    label = formatCents(priceInCents)
  } else {
    label = 'Free'
  }

  const bgClass = BADGE_STYLES[pricingModel] ?? BADGE_STYLES.free
  const textClass = TEXT_STYLES[pricingModel] ?? TEXT_STYLES.free

  return (
    <View className={`rounded-full px-2 py-0.5 ${bgClass}`}>
      <Text className={`text-[11px] font-semibold ${textClass}`}>{label}</Text>
    </View>
  )
}
