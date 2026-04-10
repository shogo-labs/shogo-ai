// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable, Image } from 'react-native'
import { Star, Download } from 'lucide-react-native'
import { PricingBadge } from './PricingBadge'
import { CreatorBadge, type CreatorTier } from './CreatorBadge'

export interface MarketplaceListingCard {
  slug: string
  title: string
  shortDescription: string
  iconUrl?: string | null
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  installCount: number
  averageRating: number
  reviewCount: number
  creator: {
    displayName: string
    creatorTier: CreatorTier
    avatarUrl?: string | null
  }
}

interface MarketplaceCardProps {
  listing: MarketplaceListingCard
  onPress: () => void
}

const ACCENT_COLORS = [
  '#8b5cf6', '#ec4899', '#f97316', '#22c55e',
  '#06b6d4', '#7c3aed', '#d946ef', '#14b8a6',
]

function getAccentColor(title: string): string {
  const idx = title.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % ACCENT_COLORS.length
  return ACCENT_COLORS[idx]
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

export function MarketplaceCard({ listing, onPress }: MarketplaceCardProps) {
  const color = getAccentColor(listing.title)
  const initial = listing.title.charAt(0).toUpperCase()

  return (
    <Pressable
      onPress={onPress}
      className="flex-1 m-1.5 rounded-2xl border border-border bg-card overflow-hidden active:opacity-90"
    >
      {/* Icon area */}
      <View
        className="h-24 items-center justify-center"
        style={{ backgroundColor: `${color}0d` }}
      >
        {listing.iconUrl ? (
          <Image
            source={{ uri: listing.iconUrl }}
            className="w-14 h-14 rounded-xl"
            resizeMode="cover"
          />
        ) : (
          <View
            className="w-14 h-14 rounded-xl items-center justify-center"
            style={{ backgroundColor: `${color}22` }}
          >
            <Text style={{ color, fontSize: 22, fontWeight: '700' }}>{initial}</Text>
          </View>
        )}
      </View>

      {/* Content */}
      <View className="px-3 py-2.5 gap-1.5">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {listing.title}
        </Text>
        <Text className="text-xs text-muted-foreground leading-4" numberOfLines={2}>
          {listing.shortDescription}
        </Text>

        <CreatorBadge
          tier={listing.creator.creatorTier}
          displayName={listing.creator.displayName}
          avatarUrl={listing.creator.avatarUrl}
        />

        {/* Bottom row: pricing + stats */}
        <View className="flex-row items-center justify-between mt-0.5">
          <PricingBadge
            pricingModel={listing.pricingModel}
            priceInCents={listing.priceInCents}
            monthlyPriceInCents={listing.monthlyPriceInCents}
          />
          <View className="flex-row items-center gap-2">
            {listing.averageRating > 0 && (
              <View className="flex-row items-center gap-0.5">
                <Star size={11} fill="#eab308" color="#eab308" />
                <Text className="text-[10px] text-muted-foreground">
                  {listing.averageRating.toFixed(1)}
                </Text>
              </View>
            )}
            <View className="flex-row items-center gap-0.5">
              <Download size={10} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">
                {formatCount(listing.installCount)}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  )
}
