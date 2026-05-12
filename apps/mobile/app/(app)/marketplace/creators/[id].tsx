// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Image,
  FlatList,
  Linking,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ArrowLeft, ShieldCheck, ExternalLink, Share2, UserPlus, Award } from 'lucide-react-native'
import { useDomainHttp } from '../../../../contexts/domain'
import {
  AgentTile,
  type AgentTileListing,
  HorizontalRail,
  MarketplaceHero,
  SectionHeader,
  TIER_BG,
  TIER_LABEL,
  type CreatorTier,
} from '../../../../components/marketplace'
import { useGridColumns } from '../../../../hooks/useGridColumns'

interface CreatorPublicProfile {
  id: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  websiteUrl: string | null
  verified: boolean
  creatorTier: CreatorTier
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
  averageAgentRating: number
  badges: Array<{
    badgeType: string
    earnedAt: string
    metadata: unknown
  }>
}

interface CreatorListing {
  slug: string
  title: string
  shortDescription: string
  iconUrl?: string | null
  screenshotUrls?: string[]
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  installCount: number
  averageRating: number
  reviewCount: number
  featuredAt?: string | null
  creatorId: string
  creator?: {
    id?: string
    displayName: string
    creatorTier: CreatorTier
    avatarUrl?: string | null
    verified?: boolean
  }
}

const BADGE_LABELS: Record<string, { label: string; icon: string }> = {
  first_agent: { label: 'First agent', icon: '🚀' },
  popular_10: { label: '10 installs', icon: '⭐' },
  popular_100: { label: '100 installs', icon: '💯' },
  popular_1000: { label: '1k installs', icon: '🏆' },
  top_rated: { label: 'Top rated', icon: '🏅' },
  five_star: { label: 'Five-star review', icon: '⭐' },
  prolific_builder: { label: 'Prolific builder', icon: '🔨' },
  master_builder: { label: 'Master builder', icon: '👑' },
  active_maintainer: { label: 'Active maintainer', icon: '🔧' },
  streak_3: { label: '3-month streak', icon: '🔧' },
  streak_6: { label: '6-month streak', icon: '🛠' },
  streak_12: { label: '12-month streak', icon: '⚙️' },
  multi_category: { label: 'Multi-category', icon: '🎯' },
  early_adopter: { label: 'Early adopter', icon: '🌱' },
  verified_creator: { label: 'Verified creator', icon: '✓' },
}

function toTileListing(item: CreatorListing, fallbackCreator: CreatorPublicProfile): AgentTileListing {
  return {
    slug: item.slug,
    title: item.title,
    shortDescription: item.shortDescription,
    iconUrl: item.iconUrl,
    previewUrl: item.screenshotUrls?.[0] ?? null,
    pricingModel: item.pricingModel,
    priceInCents: item.priceInCents,
    monthlyPriceInCents: item.monthlyPriceInCents,
    installCount: item.installCount,
    averageRating: item.averageRating,
    reviewCount: item.reviewCount,
    featured: !!item.featuredAt,
    creator: {
      id: fallbackCreator.id,
      displayName: fallbackCreator.displayName,
      creatorTier: fallbackCreator.creatorTier,
      avatarUrl: fallbackCreator.avatarUrl,
      verified: fallbackCreator.verified,
    },
  }
}

export default observer(function CreatorProfileScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const http = useDomainHttp()
  const numColumns = useGridColumns()

  const [profile, setProfile] = useState<CreatorPublicProfile | null>(null)
  const [listings, setListings] = useState<CreatorListing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  const load = useCallback(async () => {
    if (!id) return
    try {
      setLoading(true)
      const [profileRes, listingsRes] = await Promise.all([
        http.get<CreatorPublicProfile>(`/api/marketplace/creators/${id}`),
        http.get<{ items: CreatorListing[] }>(
          `/api/marketplace?creatorId=${encodeURIComponent(id)}&sort=popular&limit=50`,
        ),
      ])
      setProfile(profileRes.data)
      setListings(listingsRes.data.items ?? [])
      setError(null)
    } catch (err: any) {
      console.error('[CreatorProfile] load failed:', err)
      setError('Failed to load creator')
    } finally {
      setLoading(false)
    }
  }, [http, id])

  useEffect(() => {
    load()
  }, [load])

  const featured = useMemo(() => {
    if (listings.length === 0) return null
    // Pick the highest-rated listing with at least one review, fall back
    // to the most-installed listing.
    const sorted = [...listings].sort((a, b) => {
      if (b.reviewCount > 0 && a.reviewCount > 0) return b.averageRating - a.averageRating
      return b.installCount - a.installCount
    })
    return sorted[0]
  }, [listings])

  const restListings = useMemo(() => {
    if (!featured) return listings
    return listings.filter((l) => l.slug !== featured.slug)
  }, [listings, featured])

  const handleListingPress = useCallback(
    (slug: string) => router.push(`/(app)/marketplace/${slug}` as any),
    [router],
  )

  if (loading || !profile) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
          <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
            <ArrowLeft size={20} color="#71717a" />
          </Pressable>
        </View>
        <View className="flex-1 items-center justify-center">
          {error ? (
            <View className="items-center px-6">
              <Text className="text-foreground font-medium mb-1">{error}</Text>
              <Pressable
                onPress={load}
                className="mt-4 bg-primary px-4 py-2 rounded-lg"
              >
                <Text className="text-primary-foreground text-sm font-medium">Try again</Text>
              </Pressable>
            </View>
          ) : (
            <ActivityIndicator size="large" />
          )}
        </View>
      </View>
    )
  }

  const tierBg = TIER_BG[profile.creatorTier] ?? TIER_BG.newcomer

  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1" numberOfLines={1}>
          {profile.displayName}
        </Text>
        <Pressable hitSlop={6} className="p-1.5 active:opacity-60">
          <Share2 size={18} color="#71717a" />
        </Pressable>
      </View>

      <FlatList
        key={`profile-grid-${numColumns}`}
        data={restListings}
        keyExtractor={(item) => item.slug}
        numColumns={viewMode === 'list' ? 1 : numColumns}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 32 }}
        ListHeaderComponent={
          <View>
            {/* Hero */}
            <MarketplaceHero
              accent="#7c3aed"
              eyebrow={`${TIER_LABEL[profile.creatorTier]} creator`}
              title={profile.displayName}
              subtitle={profile.bio || `Building agents on Shogo since joining the marketplace.`}
              trailing={
                profile.avatarUrl ? (
                  <Image
                    source={{ uri: profile.avatarUrl }}
                    style={{ width: 96, height: 96, borderRadius: 999 }}
                  />
                ) : (
                  <View
                    className={`${tierBg} rounded-full items-center justify-center`}
                    style={{ width: 96, height: 96 }}
                  >
                    <Text className="text-white font-bold text-3xl">
                      {profile.displayName.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )
              }
            >
              <View className="gap-3">
                <View className="flex-row items-center gap-2 flex-wrap">
                  {profile.verified && (
                    <View className="flex-row items-center gap-1 rounded-full bg-blue-500/15 px-2 py-1">
                      <ShieldCheck size={12} color="#3b82f6" />
                      <Text className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                        Verified
                      </Text>
                    </View>
                  )}
                  <View className="rounded-full bg-foreground/10 px-2.5 py-1">
                    <Text className="text-[11px] font-medium text-foreground/80">
                      {profile.reputationScore} reputation
                    </Text>
                  </View>
                </View>
                <View className="flex-row items-center gap-5 flex-wrap">
                  <ProfileStat label="Agents" value={String(profile.totalAgentsPublished)} />
                  <ProfileStat
                    label="Installs"
                    value={profile.totalInstalls.toLocaleString()}
                  />
                  <ProfileStat
                    label="Avg rating"
                    value={
                      profile.averageAgentRating > 0
                        ? profile.averageAgentRating.toFixed(1)
                        : '—'
                    }
                  />
                  <ProfileStat label="Badges" value={String(profile.badges.length)} />
                </View>
                <View className="flex-row items-center gap-2 mt-2">
                  <Pressable className="flex-row items-center gap-1.5 rounded-xl bg-foreground/10 px-4 py-2 active:opacity-80">
                    <UserPlus size={14} color="#71717a" />
                    <Text className="text-xs font-semibold text-foreground">Follow</Text>
                  </Pressable>
                  {profile.websiteUrl && (
                    <Pressable
                      className="flex-row items-center gap-1.5 rounded-xl border border-border px-4 py-2 active:opacity-80"
                      onPress={() => {
                        Linking.openURL(profile.websiteUrl!).catch(() => undefined)
                      }}
                    >
                      <ExternalLink size={14} color="#71717a" />
                      <Text className="text-xs font-medium text-foreground">Website</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </MarketplaceHero>

            {/* Badges */}
            {profile.badges.length > 0 && (
              <View className="mt-8 mb-8">
                <SectionHeader
                  title="Badges"
                  subtitle="Milestones earned across the marketplace"
                />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
                >
                  {profile.badges.map((b, i) => {
                    const data =
                      BADGE_LABELS[b.badgeType] ?? { label: b.badgeType, icon: '🏅' }
                    return (
                      <View
                        key={`${b.badgeType}-${i}`}
                        className="rounded-2xl border border-border bg-card px-3 py-2.5 flex-row items-center gap-2"
                      >
                        <View className="rounded-full bg-yellow-500/15 w-8 h-8 items-center justify-center">
                          <Text style={{ fontSize: 16 }}>{data.icon}</Text>
                        </View>
                        <View>
                          <Text className="text-xs font-semibold text-foreground">
                            {data.label}
                          </Text>
                          <Text className="text-[10px] text-muted-foreground">
                            {new Date(b.earnedAt).toLocaleDateString(undefined, {
                              month: 'short',
                              year: 'numeric',
                            })}
                          </Text>
                        </View>
                      </View>
                    )
                  })}
                </ScrollView>
              </View>
            )}

            {/* Featured agent */}
            {featured && (
              <View className="px-5 mt-2 mb-8">
                <SectionHeader title="Featured agent" padded={false} />
                <AgentTile
                  size="spotlight"
                  listing={toTileListing(featured, profile)}
                  onPress={() => handleListingPress(featured.slug)}
                />
              </View>
            )}

            {/* Listings header */}
            <View className="px-5 mb-3 flex-row items-end justify-between">
              <SectionHeader
                title={`All agents (${listings.length})`}
                padded={false}
              />
              <View className="flex-row items-center rounded-xl border border-border bg-card overflow-hidden">
                <Pressable
                  onPress={() => setViewMode('grid')}
                  className={`px-3 py-1.5 ${viewMode === 'grid' ? 'bg-muted' : ''}`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      viewMode === 'grid' ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    Grid
                  </Text>
                </Pressable>
                <View className="w-px h-5 bg-border" />
                <Pressable
                  onPress={() => setViewMode('list')}
                  className={`px-3 py-1.5 ${viewMode === 'list' ? 'bg-muted' : ''}`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      viewMode === 'list' ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    List
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        }
        renderItem={({ item }) => {
          if (viewMode === 'list') {
            return (
              <View className="px-5 pb-3">
                <AgentTile
                  size="compact"
                  listing={toTileListing(item, profile)}
                  onPress={() => handleListingPress(item.slug)}
                />
              </View>
            )
          }
          return (
            <AgentTile
              size="medium"
              listing={toTileListing(item, profile)}
              onPress={() => handleListingPress(item.slug)}
            />
          )
        }}
        ListEmptyComponent={
          listings.length === 0 ? (
            <View className="items-center py-12 px-6">
              <Award size={32} color="#a1a1aa" />
              <Text className="text-foreground font-medium mt-3 mb-1">
                No agents yet
              </Text>
              <Text className="text-muted-foreground text-sm text-center">
                {profile.displayName} hasn&apos;t published any agents yet.
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  )
})

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="text-base font-bold text-foreground">{value}</Text>
      <Text
        className="text-[10px] text-muted-foreground mt-0.5 uppercase"
        style={{ letterSpacing: 0.4 }}
      >
        {label}
      </Text>
    </View>
  )
}
