// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable, Image } from 'react-native'
import { Star, Download, ArrowRight } from 'lucide-react-native'
import { CreatorChip, type CreatorTier } from './CreatorChip'
import { PriceTag, type PricingModel } from './PriceTag'
import { QualityBadge } from './QualityBadge'
import { getAccentColor, getInitial } from './accent'

export interface AgentTileListing {
  slug: string
  title: string
  shortDescription: string
  iconUrl?: string | null
  /** First screenshot URL is used as the preview thumbnail when present. */
  previewUrl?: string | null
  pricingModel: PricingModel
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  installCount: number
  averageRating: number
  reviewCount: number
  /** Set when the listing is editorially featured (drives the QualityBadge). */
  featured?: boolean
  creator: {
    id?: string | null
    displayName: string
    creatorTier: CreatorTier
    avatarUrl?: string | null
    verified?: boolean
  }
}

export type AgentTileSize = 'spotlight' | 'featured' | 'medium' | 'compact'

interface AgentTileProps {
  listing: AgentTileListing
  size: AgentTileSize
  onPress: () => void
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/**
 * Unified marketplace tile. Picks one of four layouts depending on
 * `size`. All variants share the same accent-color logic, creator chip,
 * price tag, and rating footer so the family feels cohesive across
 * spotlights, rails, and grids.
 */
export function AgentTile({ listing, size, onPress }: AgentTileProps) {
  switch (size) {
    case 'spotlight':
      return <SpotlightTile listing={listing} onPress={onPress} />
    case 'featured':
      return <FeaturedTile listing={listing} onPress={onPress} />
    case 'compact':
      return <CompactTile listing={listing} onPress={onPress} />
    case 'medium':
    default:
      return <MediumTile listing={listing} onPress={onPress} />
  }
}

// ─── Spotlight: full-bleed hero card ────────────────────────────────
function SpotlightTile({ listing, onPress }: { listing: AgentTileListing; onPress: () => void }) {
  const accent = getAccentColor(listing.title)
  return (
    <Pressable
      onPress={onPress}
      className="overflow-hidden rounded-3xl border border-border active:opacity-95"
      style={{ backgroundColor: `${accent}1a` }}
    >
      <View
        className="flex-row p-6 gap-5 min-h-[180px]"
        style={{ backgroundColor: `${accent}12` }}
      >
        <View className="flex-1 justify-between gap-4 min-w-0">
          <View className="flex-row items-center gap-2">
            {listing.featured && <QualityBadge size="sm" />}
            <View className="rounded-full bg-foreground/10 px-2 py-0.5">
              <Text className="text-[10px] font-bold text-foreground/70" style={{ letterSpacing: 1 }}>
                SPOTLIGHT
              </Text>
            </View>
          </View>
          <View>
            <Text
              className="text-2xl font-bold text-foreground mb-1.5"
              numberOfLines={2}
            >
              {listing.title}
            </Text>
            <Text className="text-sm text-foreground/70" numberOfLines={2}>
              {listing.shortDescription}
            </Text>
          </View>
          <View className="flex-row items-center justify-between">
            <CreatorChip
              creatorId={listing.creator.id}
              displayName={listing.creator.displayName}
              tier={listing.creator.creatorTier}
              avatarUrl={listing.creator.avatarUrl}
              verified={listing.creator.verified}
              size="sm"
              disablePress
            />
            <View className="flex-row items-center gap-2">
              <PriceTag
                pricingModel={listing.pricingModel}
                priceInCents={listing.priceInCents}
                monthlyPriceInCents={listing.monthlyPriceInCents}
              />
              <View className="flex-row items-center gap-1 rounded-full bg-foreground px-3 py-1.5">
                <Text className="text-xs font-semibold text-background">View</Text>
                <ArrowRight size={12} color="#fff" />
              </View>
            </View>
          </View>
        </View>
        {/* Icon panel */}
        <View
          className="rounded-2xl items-center justify-center"
          style={{
            width: 110,
            height: 110,
            backgroundColor: `${accent}33`,
            alignSelf: 'center',
          }}
        >
          {listing.iconUrl ? (
            <Image
              source={{ uri: listing.iconUrl }}
              style={{ width: 80, height: 80, borderRadius: 16 }}
              resizeMode="cover"
            />
          ) : (
            <Text style={{ color: accent, fontSize: 48, fontWeight: '700' }}>
              {getInitial(listing.title)}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  )
}

// ─── Featured: wide horizontal card ─────────────────────────────────
function FeaturedTile({ listing, onPress }: { listing: AgentTileListing; onPress: () => void }) {
  const accent = getAccentColor(listing.title)
  return (
    <Pressable
      onPress={onPress}
      className="overflow-hidden rounded-2xl border border-border active:opacity-90 bg-card"
    >
      {/* Preview area — uses first screenshot when present, gradient fallback otherwise */}
      <View
        className="h-32 items-center justify-center"
        style={{ backgroundColor: `${accent}22` }}
      >
        {listing.previewUrl ? (
          <Image
            source={{ uri: listing.previewUrl }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        ) : listing.iconUrl ? (
          <Image
            source={{ uri: listing.iconUrl }}
            style={{ width: 56, height: 56, borderRadius: 12 }}
          />
        ) : (
          <Text style={{ color: accent, fontSize: 36, fontWeight: '700' }}>
            {getInitial(listing.title)}
          </Text>
        )}
        {listing.featured && (
          <View className="absolute top-2 left-2">
            <QualityBadge size="sm" />
          </View>
        )}
      </View>
      <View className="px-3 py-3 gap-2">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {listing.title}
        </Text>
        <Text className="text-xs text-muted-foreground leading-4" numberOfLines={2}>
          {listing.shortDescription}
        </Text>
        <CreatorChip
          creatorId={listing.creator.id}
          displayName={listing.creator.displayName}
          tier={listing.creator.creatorTier}
          avatarUrl={listing.creator.avatarUrl}
          verified={listing.creator.verified}
          size="xs"
          disablePress
        />
        <View className="flex-row items-center justify-between mt-0.5">
          <PriceTag
            pricingModel={listing.pricingModel}
            priceInCents={listing.priceInCents}
            monthlyPriceInCents={listing.monthlyPriceInCents}
          />
          <RatingAndInstalls listing={listing} />
        </View>
      </View>
    </Pressable>
  )
}

// ─── Medium: refreshed grid card (replaces old MarketplaceCard) ─────
function MediumTile({ listing, onPress }: { listing: AgentTileListing; onPress: () => void }) {
  const accent = getAccentColor(listing.title)
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 m-1.5 rounded-2xl border border-border bg-card overflow-hidden active:opacity-90"
    >
      <View
        className="h-24 items-center justify-center relative"
        style={{ backgroundColor: `${accent}14` }}
      >
        {listing.iconUrl ? (
          <Image
            source={{ uri: listing.iconUrl }}
            style={{ width: 56, height: 56, borderRadius: 12 }}
            resizeMode="cover"
          />
        ) : (
          <View
            className="rounded-2xl items-center justify-center"
            style={{ width: 56, height: 56, backgroundColor: `${accent}33` }}
          >
            <Text style={{ color: accent, fontSize: 22, fontWeight: '700' }}>
              {getInitial(listing.title)}
            </Text>
          </View>
        )}
        {listing.featured && (
          <View className="absolute top-2 right-2">
            <QualityBadge size="sm" iconOnly />
          </View>
        )}
      </View>
      <View className="px-3 py-3 gap-1.5">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {listing.title}
        </Text>
        <Text className="text-xs text-muted-foreground leading-4" numberOfLines={2}>
          {listing.shortDescription}
        </Text>
        <CreatorChip
          creatorId={listing.creator.id}
          displayName={listing.creator.displayName}
          tier={listing.creator.creatorTier}
          avatarUrl={listing.creator.avatarUrl}
          verified={listing.creator.verified}
          size="xs"
          disablePress
        />
        <View className="flex-row items-center justify-between mt-0.5">
          <PriceTag
            pricingModel={listing.pricingModel}
            priceInCents={listing.priceInCents}
            monthlyPriceInCents={listing.monthlyPriceInCents}
          />
          <RatingAndInstalls listing={listing} />
        </View>
      </View>
    </Pressable>
  )
}

// ─── Compact: single-row list item ──────────────────────────────────
function CompactTile({ listing, onPress }: { listing: AgentTileListing; onPress: () => void }) {
  const accent = getAccentColor(listing.title)
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 px-3 py-3 rounded-xl border border-border bg-card active:opacity-90"
    >
      {listing.iconUrl ? (
        <Image
          source={{ uri: listing.iconUrl }}
          style={{ width: 44, height: 44, borderRadius: 10 }}
        />
      ) : (
        <View
          className="rounded-xl items-center justify-center"
          style={{ width: 44, height: 44, backgroundColor: `${accent}22` }}
        >
          <Text style={{ color: accent, fontSize: 18, fontWeight: '700' }}>
            {getInitial(listing.title)}
          </Text>
        </View>
      )}
      <View className="flex-1 min-w-0 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-semibold text-foreground flex-1" numberOfLines={1}>
            {listing.title}
          </Text>
          {listing.featured && <QualityBadge size="sm" iconOnly />}
        </View>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {listing.shortDescription}
        </Text>
        <View className="flex-row items-center gap-2 mt-0.5">
          <CreatorChip
            creatorId={listing.creator.id}
            displayName={listing.creator.displayName}
            tier={listing.creator.creatorTier}
            avatarUrl={listing.creator.avatarUrl}
            verified={listing.creator.verified}
            size="xs"
            disablePress
          />
          <RatingAndInstalls listing={listing} />
        </View>
      </View>
      <PriceTag
        pricingModel={listing.pricingModel}
        priceInCents={listing.priceInCents}
        monthlyPriceInCents={listing.monthlyPriceInCents}
      />
    </Pressable>
  )
}

function RatingAndInstalls({ listing }: { listing: AgentTileListing }) {
  return (
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
        <Download size={10} color="#a1a1aa" />
        <Text className="text-[10px] text-muted-foreground">
          {formatCount(listing.installCount)}
        </Text>
      </View>
    </View>
  )
}
