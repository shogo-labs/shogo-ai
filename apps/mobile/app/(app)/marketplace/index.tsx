// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  FlatList,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter } from 'expo-router'
import { Search, ArrowLeft, TrendingUp, UserCircle } from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { MarketplaceCard, type MarketplaceListingCard } from '../../../components/marketplace/MarketplaceCard'
import type { CreatorTier } from '../../../components/marketplace/CreatorBadge'

const CATEGORIES = [
  'All',
  'Personal',
  'Development',
  'Business',
  'Research',
  'Operations',
  'Marketing',
  'Sales',
] as const

type Category = (typeof CATEGORIES)[number]

interface ListingFromAPI {
  id: string
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
  creatorId: string
  creator?: {
    displayName: string
    creatorTier: CreatorTier
    avatarUrl?: string | null
  }
}

interface BrowseResponse {
  items: ListingFromAPI[]
  total: number
  page: number
  limit: number
  totalPages: number
}

interface FeaturedResponse {
  items: ListingFromAPI[]
}

function toCardListing(item: ListingFromAPI): MarketplaceListingCard {
  return {
    slug: item.slug,
    title: item.title,
    shortDescription: item.shortDescription,
    iconUrl: item.iconUrl,
    pricingModel: item.pricingModel,
    priceInCents: item.priceInCents,
    monthlyPriceInCents: item.monthlyPriceInCents,
    installCount: item.installCount,
    averageRating: item.averageRating,
    reviewCount: item.reviewCount,
    creator: item.creator ?? {
      displayName: 'Unknown',
      creatorTier: 'newcomer' as CreatorTier,
    },
  }
}

export default observer(function MarketplaceHomeScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const { width } = useWindowDimensions()
  const numColumns = width >= 600 ? 2 : 1

  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<Category>('All')
  const [listings, setListings] = useState<ListingFromAPI[]>([])
  const [featured, setFeatured] = useState<ListingFromAPI[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)

  const categoryParam = activeCategory === 'All' ? undefined : activeCategory.toLowerCase()

  const loadListings = useCallback(
    async (pageNum: number, append = false) => {
      try {
        if (pageNum === 1) setLoading(true)
        else setLoadingMore(true)

        let url = '/api/marketplace?sort=popular&limit=20&page=' + pageNum
        if (categoryParam) url += `&category=${categoryParam}`
        if (searchQuery.trim()) {
          url = `/api/marketplace/search?q=${encodeURIComponent(searchQuery.trim())}&limit=20&page=${pageNum}`
          if (categoryParam) url += `&category=${categoryParam}`
        }

        const res = await http.get<BrowseResponse>(url)
        const data = res.data
        if (append) {
          setListings((prev) => [...prev, ...data.items])
        } else {
          setListings(data.items)
        }
        setTotalPages(data.totalPages)
        setPage(pageNum)
        setError(null)
      } catch (err: any) {
        console.error('[Marketplace] Failed to load listings:', err)
        if (pageNum === 1) setError('Failed to load marketplace')
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [http, categoryParam, searchQuery],
  )

  const loadFeatured = useCallback(async () => {
    try {
      const res = await http.get<FeaturedResponse>('/api/marketplace/featured?limit=6')
      setFeatured(res.data.items)
    } catch (err) {
      console.error('[Marketplace] Failed to load featured:', err)
    }
  }, [http])

  useEffect(() => {
    loadListings(1)
  }, [activeCategory, searchQuery])

  useEffect(() => {
    loadFeatured()
  }, [loadFeatured])

  const handleLoadMore = useCallback(() => {
    if (loadingMore || page >= totalPages) return
    loadListings(page + 1, true)
  }, [loadingMore, page, totalPages, loadListings])

  const handleCardPress = useCallback(
    (slug: string) => {
      router.push(`/(app)/marketplace/${slug}` as any)
    },
    [router],
  )

  const featuredCards = useMemo(
    () => featured.map(toCardListing),
    [featured],
  )

  const listData = useMemo((): MarketplaceListingCard[] => {
    return listings.map(toCardListing)
  }, [listings])

  const paddedData = useMemo(() => {
    if (numColumns <= 1) return listData
    const remainder = listData.length % numColumns
    if (remainder === 0) return listData
    return [...listData, ...Array(numColumns - remainder).fill(null)]
  }, [listData, numColumns])

  const renderItem = useCallback(
    ({ item }: { item: MarketplaceListingCard | null }) => {
      if (!item) return <View className="flex-1 m-1.5" />
      return (
        <MarketplaceCard
          listing={item}
          onPress={() => handleCardPress(item.slug)}
        />
      )
    },
    [handleCardPress],
  )

  const ListHeader = useMemo(
    () => (
      <>
        {/* Featured section */}
        {featuredCards.length > 0 && !searchQuery && (
          <View className="mb-4">
            <View className="flex-row items-center gap-2 px-4 mb-2">
              <TrendingUp size={16} className="text-primary" />
              <Text className="text-sm font-semibold text-foreground">Featured</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="px-2.5"
            >
              {featuredCards.map((item) => (
                <View key={item.slug} style={{ width: 200 }}>
                  <MarketplaceCard
                    listing={item}
                    onPress={() => handleCardPress(item.slug)}
                  />
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Results header */}
        <View className="px-4 mb-1">
          <Text className="text-xs text-muted-foreground">
            {loading ? 'Loading...' : `${listings.length} agent${listings.length !== 1 ? 's' : ''}`}
          </Text>
        </View>
      </>
    ),
    [featuredCards, searchQuery, handleCardPress, loading, listings.length],
  )

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-4 pt-3 pb-2">
        <Pressable onPress={() => router.back()} className="p-1">
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-semibold text-foreground flex-1">Marketplace</Text>
        <Pressable
          onPress={() => router.push('/(app)/marketplace/creator' as any)}
          className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary"
        >
          <UserCircle size={14} color="#fff" />
          <Text className="text-xs font-semibold text-primary-foreground">Creator</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View className="px-4 pb-2">
        <View className="flex-row items-center bg-card border border-input rounded-xl px-3 h-10">
          <Search size={16} className="text-muted-foreground" />
          <TextInput
            className="flex-1 ml-2 text-sm text-foreground web:outline-none"
            placeholder="Search agents..."
            placeholderTextColor="#71717a"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
      </View>

      {/* Category pills */}
      <View className="pb-3">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="px-4 gap-2 items-center"
        >
          {CATEGORIES.map((cat) => (
            <Pressable
              key={cat}
              onPress={() => setActiveCategory(cat)}
              className={`rounded-full px-3.5 py-1.5 border ${
                activeCategory === cat
                  ? 'bg-primary border-primary'
                  : 'bg-card border-border'
              }`}
            >
              <Text
                className={`text-xs font-medium ${
                  activeCategory === cat
                    ? 'text-primary-foreground'
                    : 'text-foreground'
                }`}
              >
                {cat}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Content */}
      {loading && listings.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground mt-3 text-sm">Loading marketplace...</Text>
        </View>
      ) : error && listings.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-foreground font-medium mb-1">Something went wrong</Text>
          <Text className="text-muted-foreground text-sm text-center mb-4">{error}</Text>
          <Pressable
            onPress={() => loadListings(1)}
            className="bg-primary px-4 py-2 rounded-lg"
          >
            <Text className="text-primary-foreground text-sm font-medium">Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          key={`grid-${numColumns}`}
          data={paddedData}
          keyExtractor={(item, index) => item?.slug ?? `spacer-${index}`}
          renderItem={renderItem}
          numColumns={numColumns}
          contentContainerClassName="px-1 pb-8"
          ListHeaderComponent={ListHeader}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-4 items-center">
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            !loading ? (
              <View className="items-center justify-center py-20">
                <Search size={32} className="text-muted-foreground/50 mb-4" />
                <Text className="text-foreground font-medium mb-1">No agents found</Text>
                <Text className="text-muted-foreground text-sm text-center">
                  {searchQuery
                    ? `No results for "${searchQuery}"`
                    : 'No agents available in this category yet'}
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  )
})
