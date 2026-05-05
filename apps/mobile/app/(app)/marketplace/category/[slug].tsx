// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  FlatList,
  ActivityIndicator,
} from 'react-native'
import * as Lucide from 'lucide-react-native'
import { observer } from 'mobx-react-lite'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { ArrowLeft, Search } from 'lucide-react-native'
import { useDomainHttp } from '../../../../contexts/domain'
import {
  AgentTile,
  type AgentTileListing,
  HorizontalRail,
  MarketplaceHero,
  SectionHeader,
  type CreatorTier,
} from '../../../../components/marketplace'
import { findCategory } from '@shogo/shared-app'
import { useGridColumns } from '../../../../hooks/useGridColumns'

interface ListingFromAPI {
  id: string
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

interface BrowseResponse {
  items: ListingFromAPI[]
  total: number
  page: number
  totalPages: number
}

type SortMode = 'popular' | 'newest' | 'rating'
type Filter = 'all' | 'free'

const SORT_LABELS: Record<SortMode, string> = {
  popular: 'Popular',
  newest: 'Newest',
  rating: 'Top rated',
}

function toTile(item: ListingFromAPI): AgentTileListing {
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
    creator: item.creator
      ? {
          id: item.creator.id ?? item.creatorId,
          displayName: item.creator.displayName,
          creatorTier: item.creator.creatorTier,
          avatarUrl: item.creator.avatarUrl,
          verified: item.creator.verified,
        }
      : {
          id: item.creatorId,
          displayName: 'Unknown',
          creatorTier: 'newcomer',
        },
  }
}

function getLucideIcon(name: string) {
  return ((Lucide as any)[name] ?? Lucide.Sparkles) as React.ComponentType<{
    size?: number
    color?: string
  }>
}

export default observer(function CategoryLandingScreen() {
  const router = useRouter()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const http = useDomainHttp()
  const numColumns = useGridColumns()

  const category = useMemo(() => findCategory(slug), [slug])

  const [sortMode, setSortMode] = useState<SortMode>('popular')
  const [filter, setFilter] = useState<Filter>('all')

  const [listings, setListings] = useState<ListingFromAPI[]>([])
  const [featured, setFeatured] = useState<ListingFromAPI[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadGrid = useCallback(
    async (pageNum: number, append = false) => {
      if (!category) return
      try {
        if (pageNum === 1) setLoading(true)
        else setLoadingMore(true)

        const params = new URLSearchParams()
        params.set('category', category.slug)
        params.set('sort', sortMode)
        params.set('limit', '20')
        params.set('page', String(pageNum))
        if (filter === 'free') params.set('pricingModel', 'free')

        const res = await http.get<BrowseResponse>(`/api/marketplace?${params.toString()}`)
        if (append) setListings((prev) => [...prev, ...res.data.items])
        else setListings(res.data.items)
        setTotal(res.data.total)
        setTotalPages(res.data.totalPages)
        setPage(pageNum)
        setError(null)
      } catch (err: any) {
        console.error('[Category] grid load failed:', err)
        if (pageNum === 1) setError('Failed to load category')
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [http, category, sortMode, filter],
  )

  const loadFeatured = useCallback(async () => {
    if (!category) return
    try {
      const res = await http.get<BrowseResponse>(
        `/api/marketplace?category=${encodeURIComponent(category.slug)}&sort=featured&limit=8`,
      )
      // The API doesn't filter by featuredAt directly when using sort=featured,
      // but featured items always come first — slice them out.
      setFeatured((res.data.items ?? []).filter((i) => !!i.featuredAt).slice(0, 6))
    } catch (err) {
      console.error('[Category] featured load failed:', err)
    }
  }, [http, category])

  useEffect(() => {
    loadGrid(1)
  }, [loadGrid])

  useEffect(() => {
    loadFeatured()
  }, [loadFeatured])

  const handleLoadMore = useCallback(() => {
    if (loadingMore || page >= totalPages) return
    loadGrid(page + 1, true)
  }, [loadingMore, page, totalPages, loadGrid])

  if (!category) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
          <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
            <ArrowLeft size={20} color="#71717a" />
          </Pressable>
        </View>
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-foreground font-medium mb-1">Category not found</Text>
          <Pressable
            onPress={() => router.replace('/(app)/marketplace' as any)}
            className="mt-4 bg-primary px-4 py-2 rounded-lg"
          >
            <Text className="text-primary-foreground text-sm font-medium">
              Back to marketplace
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  const Icon = getLucideIcon(category.icon)
  const tileListings = listings.map(toTile)
  const padded = (() => {
    if (numColumns <= 1) return tileListings
    const remainder = tileListings.length % numColumns
    if (remainder === 0) return tileListings
    return [...tileListings, ...Array(numColumns - remainder).fill(null)]
  })()

  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">
          {category.label}
        </Text>
      </View>

      <FlatList
        key={`grid-${numColumns}`}
        data={padded}
        keyExtractor={(item, index) => item?.slug ?? `spacer-${index}`}
        numColumns={numColumns}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 32 }}
        renderItem={({ item }) => {
          if (!item) return <View className="flex-1 m-1.5" />
          return (
            <AgentTile
              size="medium"
              listing={item}
              onPress={() => router.push(`/(app)/marketplace/${item.slug}` as any)}
            />
          )
        }}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View>
            {/* Hero */}
            <MarketplaceHero
              accent={category.accent}
              eyebrow={category.label}
              title={`${category.label} agents`}
              subtitle={category.tagline}
              trailing={
                <View
                  className="rounded-2xl items-center justify-center"
                  style={{
                    width: 80,
                    height: 80,
                    backgroundColor: `${category.accent}33`,
                  }}
                >
                  <Icon size={36} color={category.accent} />
                </View>
              }
            >
              <View className="flex-row items-center gap-2">
                <View className="rounded-full bg-foreground/10 px-2.5 py-1">
                  <Text className="text-[11px] font-medium text-foreground/80">
                    {total} agent{total === 1 ? '' : 's'}
                  </Text>
                </View>
              </View>
            </MarketplaceHero>

            {/* Sort + filter chips */}
            <View className="px-5 pt-5 pb-3">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingRight: 16 }}
              >
                {(Object.keys(SORT_LABELS) as SortMode[]).map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setSortMode(s)}
                    className={`rounded-full px-3.5 h-8 items-center justify-center border ${
                      sortMode === s ? 'bg-primary border-primary' : 'bg-card border-border'
                    }`}
                  >
                    <Text
                      className={`text-xs font-medium ${
                        sortMode === s ? 'text-primary-foreground' : 'text-foreground'
                      }`}
                    >
                      {SORT_LABELS[s]}
                    </Text>
                  </Pressable>
                ))}
                <View className="w-px h-6 bg-border mx-1" />
                <Pressable
                  onPress={() => setFilter(filter === 'free' ? 'all' : 'free')}
                  className={`rounded-full px-3.5 h-8 items-center justify-center border ${
                    filter === 'free'
                      ? 'bg-emerald-500/15 border-emerald-500/40'
                      : 'bg-card border-border'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      filter === 'free'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-foreground'
                    }`}
                  >
                    Free only
                  </Text>
                </Pressable>
              </ScrollView>
            </View>

            {/* Featured rail */}
            {featured.length > 0 && filter === 'all' && (
              <View className="mb-6">
                <SectionHeader
                  title={`Featured in ${category.label}`}
                  subtitle="Editor-curated agents in this category"
                />
                <HorizontalRail
                  items={featured}
                  keyExtractor={(item) => item.slug}
                  itemWidth={260}
                  renderItem={(item) => (
                    <AgentTile
                      size="featured"
                      listing={toTile(item)}
                      onPress={() =>
                        router.push(`/(app)/marketplace/${item.slug}` as any)
                      }
                    />
                  )}
                />
              </View>
            )}

            {/* Grid header */}
            <View className="px-5 mb-3">
              <SectionHeader
                title={`All ${category.label} agents`}
                subtitle={
                  loading
                    ? 'Loading…'
                    : `${listings.length} of ${total}`
                }
                padded={false}
              />
            </View>
          </View>
        }
        ListFooterComponent={
          loadingMore ? (
            <View className="py-4 items-center">
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          !loading ? (
            <View className="items-center py-20 px-6">
              <Search size={32} color="#a1a1aa" />
              <Text className="text-foreground font-medium mt-3 mb-1">
                {error ? error : `No ${category.label} agents yet`}
              </Text>
              <Text className="text-muted-foreground text-sm text-center mb-4">
                {error
                  ? 'Please try again in a moment.'
                  : `Be the first to publish a ${category.label} agent.`}
              </Text>
              {error && (
                <Pressable
                  onPress={() => loadGrid(1)}
                  className="bg-primary px-4 py-2 rounded-lg"
                >
                  <Text className="text-primary-foreground text-sm font-medium">
                    Try again
                  </Text>
                </Pressable>
              )}
            </View>
          ) : (
            <View className="items-center py-12">
              <ActivityIndicator size="small" />
            </View>
          )
        }
      />
    </View>
  )
})
