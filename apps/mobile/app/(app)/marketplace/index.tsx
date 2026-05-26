// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  FlatList,
  ActivityIndicator,
  Image,
  Platform,
} from 'react-native'
import * as Lucide from 'lucide-react-native'
import { observer } from 'mobx-react-lite'
import { useRouter } from 'expo-router'
import {
  Search,
  ArrowLeft,
  UserCircle,
  ChevronDown,
  Grid3X3,
  List,
  ShieldCheck,
  Sparkles,
  Package,
  X,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import {
  AgentTile,
  type AgentTileListing,
  HorizontalRail,
  MarketplaceHero,
  SectionHeader,
  type CreatorTier,
} from '../../../components/marketplace'
import { MARKETPLACE_CATEGORIES, type MarketplaceCategory } from '@shogo/shared-app'
import { useAuth } from '../../../contexts/auth'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { useGridColumns } from '../../../hooks/useGridColumns'

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
  category?: string | null
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
  limit: number
  totalPages: number
}

interface FeaturedResponse {
  items: ListingFromAPI[]
}

interface LeaderboardCreator {
  id: string
  displayName: string
  avatarUrl?: string | null
  creatorTier: CreatorTier
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
}

interface LeaderboardResponse {
  items: LeaderboardCreator[]
}

type SortMode = 'popular' | 'rating' | 'newest' | 'featured'
type ViewMode = 'grid' | 'list'

const SORT_LABELS: Record<SortMode, string> = {
  popular: 'Popular',
  rating: 'Top rated',
  newest: 'Newest',
  featured: 'Featured first',
}

const SORT_SECTION_TITLES: Record<SortMode, string> = {
  popular: 'Popular this month',
  rating: 'Top rated',
  newest: 'Newest',
  featured: 'Featured first',
}

/** Rail "See all" targets — sort API param may differ from the section label. */
type BrowseFocus = 'trending' | 'newest' | 'following'

const BROWSE_FOCUS_META: Record<
  BrowseFocus,
  { title: string; subtitle: string; sort: SortMode }
> = {
  trending: {
    title: 'Trending this week',
    subtitle: 'Most-installed agents over the last 7 days',
    sort: 'popular',
  },
  newest: {
    title: 'New & noteworthy',
    subtitle: 'Recently published agents from the community',
    sort: 'newest',
  },
  following: {
    title: 'From creators you follow',
    subtitle: 'Latest from the creators you\'re following',
    sort: 'newest',
  },
}

function toTileListing(item: ListingFromAPI): AgentTileListing {
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

export default observer(function MarketplaceHomeScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const numColumns = useGridColumns()
  const { user } = useAuth()

  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearchQuery = useDebouncedValue(searchQuery)
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [sortMode, setSortMode] = useState<SortMode>('popular')
  const [filterFeatured, setFilterFeatured] = useState(false)
  const [filterFree, setFilterFree] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  /** Which rail's "See all" expanded the full browse grid (null = editorial home). */
  const [browseFocus, setBrowseFocus] = useState<BrowseFocus | null>(null)

  const [featured, setFeatured] = useState<ListingFromAPI[]>([])
  const [trending, setTrending] = useState<ListingFromAPI[]>([])
  const [newAgents, setNewAgents] = useState<ListingFromAPI[]>([])
  const [freeAgents, setFreeAgents] = useState<ListingFromAPI[]>([])
  const [topCreators, setTopCreators] = useState<LeaderboardCreator[]>([])
  const [recommended, setRecommended] = useState<ListingFromAPI[]>([])
  const [followingAgents, setFollowingAgents] = useState<ListingFromAPI[]>([])
  const [followedCreatorIds, setFollowedCreatorIds] = useState<string[]>([])

  const [listings, setListings] = useState<ListingFromAPI[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)

  const debouncedSearchTrimmed = debouncedSearchQuery.trim()
  const isSearching = debouncedSearchTrimmed.length > 0
  const isSearchPending =
    searchQuery.trim() !== debouncedSearchTrimmed
  const showRails =
    sortMode === 'popular' &&
    browseFocus === null &&
    !isSearching &&
    activeCategory === 'all' &&
    !filterFeatured &&
    !filterFree

  const browseSectionMeta = useMemo(() => {
    if (filterFeatured) {
      return { title: 'Built for Shogo', subtitle: undefined as string | undefined }
    }
    if (filterFree) {
      return { title: 'Free agents', subtitle: undefined }
    }
    if (activeCategory !== 'all') {
      return {
        title:
          MARKETPLACE_CATEGORIES.find((c) => c.slug === activeCategory)?.label ?? 'Browse',
        subtitle: undefined,
      }
    }
    if (browseFocus) {
      return {
        title: BROWSE_FOCUS_META[browseFocus].title,
        subtitle: BROWSE_FOCUS_META[browseFocus].subtitle,
      }
    }
    return { title: SORT_SECTION_TITLES[sortMode], subtitle: undefined }
  }, [activeCategory, browseFocus, filterFeatured, filterFree, sortMode])

  const loadGrid = useCallback(
    async (pageNum: number, append = false) => {
      try {
        if (pageNum === 1) {
          setLoading(true)
          if (!append) setListings([])
        } else {
          setLoadingMore(true)
        }

        const params = new URLSearchParams()
        params.set('page', String(pageNum))
        params.set('limit', '20')
        params.set('sort', sortMode)
        if (activeCategory !== 'all') params.set('category', activeCategory)
        if (filterFree) params.set('pricingModel', 'free')
        if (browseFocus === 'following' && followedCreatorIds.length > 0) {
          params.set('creatorIds', followedCreatorIds.join(','))
        }

        let url: string
        if (isSearching) {
          params.set('q', debouncedSearchTrimmed)
          url = `/api/marketplace/search?${params.toString()}`
        } else {
          url = `/api/marketplace?${params.toString()}`
        }

        const res = await http.get<BrowseResponse>(url)
        const items = filterFeatured
          ? res.data.items.filter((i) => !!i.featuredAt)
          : res.data.items
        if (append) setListings((prev) => [...prev, ...items])
        else setListings(items)
        setTotalPages(res.data.totalPages)
        setPage(pageNum)
        setError(null)
      } catch (err: any) {
        console.error('[Marketplace] grid load failed:', err)
        if (pageNum === 1) setError('Failed to load marketplace')
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [http, sortMode, activeCategory, filterFeatured, filterFree, isSearching, debouncedSearchTrimmed, browseFocus, followedCreatorIds],
  )

  const loadEditorial = useCallback(async () => {
    try {
      const [featuredRes, trendingRes, newRes, freeRes, leaderboardRes] = await Promise.all([
        http.get<FeaturedResponse>('/api/marketplace/featured?limit=8'),
        http.get<BrowseResponse>('/api/marketplace?sort=popular&limit=8'),
        http.get<BrowseResponse>('/api/marketplace?sort=newest&limit=8'),
        http.get<BrowseResponse>('/api/marketplace?pricingModel=free&sort=popular&limit=8'),
        http.get<LeaderboardResponse>('/api/marketplace/creators/leaderboard?limit=8'),
      ])
      setFeatured(featuredRes.data.items ?? [])
      setTrending(trendingRes.data.items ?? [])
      setNewAgents(newRes.data.items ?? [])
      setFreeAgents(freeRes.data.items ?? [])
      setTopCreators(leaderboardRes.data.items ?? [])
      // Recommended-for-you cold-start = popular subset, omit duplicates
      setRecommended((trendingRes.data.items ?? []).slice(0, 6))
    } catch (err) {
      console.error('[Marketplace] editorial load failed:', err)
    }
  }, [http])

  useEffect(() => {
    loadGrid(1)
  }, [activeCategory, sortMode, filterFeatured, filterFree, debouncedSearchQuery, browseFocus])

  useEffect(() => {
    setBrowseFocus(null)
  }, [activeCategory, filterFeatured, filterFree, debouncedSearchQuery])

  useEffect(() => {
    loadEditorial()
  }, [loadEditorial])

  useEffect(() => {
    if (!user?.id) {
      setFollowingAgents([])
      setFollowedCreatorIds([])
      return
    }
    ;(async () => {
      try {
        const followingRes = await http.get<{ items: Array<{ id: string }> }>(
          '/api/marketplace/creators/following?limit=50',
        )
        const creatorIds = (followingRes.data.items ?? []).map((c) => c.id)
        setFollowedCreatorIds(creatorIds)
        if (creatorIds.length === 0) return
        const agentRes = await http.get<BrowseResponse>(
          `/api/marketplace?creatorIds=${creatorIds.join(',')}&sort=newest&limit=8`,
        )
        setFollowingAgents(agentRes.data.items ?? [])
      } catch {
        // non-critical
      }
    })()
  }, [user?.id, http])

  const browseListRef = useRef<FlatList>(null)

  const scrollBrowseToTop = useCallback(() => {
    const scroll = () => {
      browseListRef.current?.scrollToOffset({ offset: 0, animated: false })
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      }
    }
    requestAnimationFrame(() => {
      scroll()
      requestAnimationFrame(scroll)
    })
  }, [])

  const focusBrowse = useCallback(
    (focus: BrowseFocus) => {
      const meta = BROWSE_FOCUS_META[focus]
      setBrowseFocus(focus)
      setSortMode(meta.sort)
      scrollBrowseToTop()
    },
    [scrollBrowseToTop],
  )

  useEffect(() => {
    if (!browseFocus && !filterFeatured && !filterFree && activeCategory === 'all') return
    scrollBrowseToTop()
  }, [browseFocus, filterFeatured, filterFree, activeCategory, viewMode, scrollBrowseToTop])

  const returnToEditorialHome = useCallback(() => {
    setBrowseFocus(null)
    setSortMode('popular')
    setFilterFeatured(false)
    setFilterFree(false)
    setActiveCategory('all')
    setSearchQuery('')
    setSortMenuOpen(false)
    scrollBrowseToTop()
  }, [scrollBrowseToTop])

  const handleTopBarBack = useCallback(() => {
    if (showRails) {
      router.back()
    } else {
      returnToEditorialHome()
    }
  }, [showRails, router, returnToEditorialHome])

  const spotlight = featured[0]
  const builtForShogo = featured.slice(1, 6)

  const handleLoadMore = useCallback(() => {
    if (loadingMore || page >= totalPages) return
    loadGrid(page + 1, true)
  }, [loadingMore, page, totalPages, loadGrid])

  const handleCardPress = useCallback(
    (slug: string) => {
      router.push(`/(app)/marketplace/${slug}` as any)
    },
    [router],
  )

  const tileListings = useMemo(() => listings.map(toTileListing), [listings])

  const paddedData = useMemo(() => {
    if (numColumns <= 1) return tileListings
    const remainder = tileListings.length % numColumns
    if (remainder === 0) return tileListings
    return [...tileListings, ...Array(numColumns - remainder).fill(null)]
  }, [tileListings, numColumns])

  const renderGridItem = useCallback(
    ({ item }: { item: AgentTileListing | null }) => {
      if (!item) return <View className="flex-1 m-1.5" />
      return (
        <AgentTile
          size="medium"
          listing={item}
          onPress={() => handleCardPress(item.slug)}
        />
      )
    },
    [handleCardPress],
  )

  const renderListItem = useCallback(
    ({ item }: { item: AgentTileListing }) => (
      <View className="px-5 pb-3">
        <AgentTile
          size="compact"
          listing={item}
          onPress={() => handleCardPress(item.slug)}
        />
      </View>
    ),
    [handleCardPress],
  )

  const ListHeader = useMemo(() => {
    if (isSearching) {
      return (
        <View className="px-5 mb-3">
          <Text className="text-sm text-muted-foreground">
            {loading || isSearchPending
              ? 'Searching…'
              : `${listings.length} result${listings.length === 1 ? '' : 's'} for “${debouncedSearchTrimmed}”`}
          </Text>
        </View>
      )
    }

    return (
      <View>
        {!showRails && !isSearching && (
          <View className="px-5 pt-2 pb-3">
            <Pressable
              onPress={returnToEditorialHome}
              className="flex-row items-center gap-1.5 self-start active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel="Back to marketplace"
            >
              <ArrowLeft size={16} color="#e27927" />
              <Text className="text-sm font-medium text-primary">Back to marketplace</Text>
            </Pressable>
          </View>
        )}

        {/* Spotlight */}
        {spotlight && showRails && (
          <View className="px-5 mt-2 mb-8">
            {viewMode === 'grid' ? (
              <AgentTile
                size="spotlight"
                listing={toTileListing(spotlight)}
                onPress={() => handleCardPress(spotlight.slug)}
              />
            ) : (
              <AgentTile
                size="compact"
                listing={toTileListing(spotlight)}
                onPress={() => handleCardPress(spotlight.slug)}
              />
            )}
          </View>
        )}

        {/* Built for Shogo */}
        {builtForShogo.length > 0 && showRails && (
          <AgentCollectionSection
            viewMode={viewMode}
            title="Built for Shogo"
            subtitle="Editor-curated agents that meet our quality bar"
            onSeeAll={() => {
              setBrowseFocus(null)
              setFilterFeatured(true)
            }}
            items={builtForShogo}
            railTileSize="featured"
            railItemWidth={260}
            onPress={handleCardPress}
          />
        )}

        {/* Recommended for you */}
        {recommended.length > 0 && showRails && (
          <AgentCollectionSection
            viewMode={viewMode}
            title="Recommended for you"
            subtitle="Popular agents that match how you work"
            items={recommended}
            onPress={handleCardPress}
          />
        )}

        {/* From creators you follow */}
        {followingAgents.length > 0 && showRails && (
          <AgentCollectionSection
            viewMode={viewMode}
            title="From creators you follow"
            subtitle="Latest from the creators you're following"
            onSeeAll={() => focusBrowse('following')}
            items={followingAgents}
            onPress={handleCardPress}
          />
        )}

        {/* Trending */}
        {trending.length > 0 && showRails && (
          <AgentCollectionSection
            viewMode={viewMode}
            title="Trending this week"
            subtitle="Most-installed agents over the last 7 days"
            onSeeAll={() => focusBrowse('trending')}
            items={trending}
            onPress={handleCardPress}
          />
        )}

        {/* New & noteworthy */}
        {newAgents.length > 0 && showRails && (
          <AgentCollectionSection
            viewMode={viewMode}
            title="New & noteworthy"
            subtitle="Recently published agents from the community"
            onSeeAll={() => focusBrowse('newest')}
            items={newAgents}
            onPress={handleCardPress}
          />
        )}

        {/* Free agents */}
        {freeAgents.length > 0 && showRails && (
          <AgentCollectionSection
            viewMode={viewMode}
            title="Free agents"
            subtitle="Try without paying anything"
            onSeeAll={() => {
              setBrowseFocus(null)
              setFilterFree(true)
            }}
            items={freeAgents}
            onPress={handleCardPress}
          />
        )}

        {/* Top creators */}
        {topCreators.length > 0 && showRails && (
          <View className="mb-8">
            <SectionHeader
              title="Top creators"
              subtitle="Builders earning the most reputation this season"
              onSeeAll={() => router.push('/(app)/marketplace/creators' as any)}
            />
            {viewMode === 'grid' ? (
              <HorizontalRail
                items={topCreators}
                keyExtractor={(c) => c.id}
                itemWidth={210}
                renderItem={(c) => (
                  <CreatorRailCard
                    creator={c}
                    onPress={() =>
                      router.push(`/(app)/marketplace/creators/${c.id}` as any)
                    }
                  />
                )}
              />
            ) : (
              <View className="px-5 gap-3">
                {topCreators.map((c) => (
                  <CreatorRailCard
                    key={c.id}
                    creator={c}
                    onPress={() =>
                      router.push(`/(app)/marketplace/creators/${c.id}` as any)
                    }
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {/* Browse by category */}
        {showRails && (
          <View className="mb-8">
            <SectionHeader
              title="Browse by category"
              subtitle="Pick a destination, not just a filter"
              padded
            />
            <View className="px-5 flex-row flex-wrap" style={{ gap: 12 }}>
              {MARKETPLACE_CATEGORIES.map((cat) => (
                <CategoryCard
                  key={cat.slug}
                  category={cat}
                  numColumns={numColumns}
                  onPress={() =>
                    router.push(`/(app)/marketplace/category/${cat.slug}` as any)
                  }
                />
              ))}
            </View>
          </View>
        )}

        {/* Bottom grid header */}
        <View className="px-5 mt-2 mb-3">
          <SectionHeader
            title={browseSectionMeta.title}
            subtitle={
              loading
                ? 'Loading…'
                : browseSectionMeta.subtitle ??
                  `${listings.length} agent${listings.length === 1 ? '' : 's'}`
            }
            padded={false}
          />
        </View>
      </View>
    )
  }, [
    isSearching,
    loading,
    listings.length,
    debouncedSearchTrimmed,
    isSearchPending,
    browseFocus,
    browseSectionMeta,
    showRails,
    spotlight,
    builtForShogo,
    recommended,
    trending,
    newAgents,
    freeAgents,
    topCreators,
    activeCategory,
    filterFeatured,
    filterFree,
    sortMode,
    returnToEditorialHome,
    handleCardPress,
    router,
    numColumns,
    viewMode,
  ])

  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="flex-row items-center px-5 pt-3 pb-2">
        <Pressable onPress={handleTopBarBack} hitSlop={6} className="p-1 mr-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1 min-w-0">
          Marketplace
        </Text>
        <View className="flex-row items-center gap-3 shrink-0">
          <Pressable
            onPress={() => router.push('/(app)/marketplace/installs' as any)}
            className="flex-row items-center gap-1.5 py-1.5 rounded-lg active:opacity-70"
          >
            <Package size={14} color="#71717a" />
            <Text className="text-xs font-medium text-muted-foreground">My Installs</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/(app)/marketplace/creators' as any)}
            className="py-1.5 rounded-lg active:opacity-70"
          >
            <Text className="text-xs font-medium text-muted-foreground">Creators</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/(app)/marketplace/creator' as any)}
            className="flex-row items-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-primary"
          >
            <UserCircle size={14} color="#fff" />
            <Text className="text-xs font-semibold text-primary-foreground">Creator</Text>
          </Pressable>
        </View>
      </View>

      {/* Editorial hero */}
      <MarketplaceHero
        eyebrow="Agent Marketplace"
        title="Discover agents built by the community"
        subtitle="Install vetted agents into your workspace, or publish your own and earn from every install."
        accent="#e27927"
        compact
      />

      {/* Search + sort + view */}
      <View className="px-5 pt-4 pb-3 gap-3">
        <View className="flex-row items-center gap-2">
          <View className="flex-row items-center bg-card border border-input rounded-xl px-3 h-11 flex-1">
            <Search size={16} color="#71717a" />
            <TextInput
              className="flex-1 ml-2 text-sm text-foreground web:outline-none no-focus-ring"
              placeholder="Search agents…"
              placeholderTextColor="#71717a"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery('')} hitSlop={6}>
                <X size={14} color="#71717a" />
              </Pressable>
            )}
          </View>
          <SortMenu
            value={sortMode}
            open={sortMenuOpen}
            onOpenChange={setSortMenuOpen}
            onChange={(v) => {
              setSortMode(v)
              setBrowseFocus(null)
              setSortMenuOpen(false)
            }}
          />
          <ViewToggle value={viewMode} onChange={setViewMode} />
        </View>

        {/* Category pills + quick filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingRight: 16 }}
        >
          <CategoryPill
            active={activeCategory === 'all'}
            label="All"
            onPress={() => setActiveCategory('all')}
          />
          {MARKETPLACE_CATEGORIES.map((cat) => (
            <CategoryPill
              key={cat.slug}
              active={activeCategory === cat.slug}
              label={cat.label}
              onPress={() => setActiveCategory(cat.slug)}
            />
          ))}
          <View className="w-px h-6 bg-border mx-1" />
          <FilterPill
            active={filterFeatured}
            icon={<ShieldCheck size={12} color={filterFeatured ? '#e27927' : '#71717a'} />}
            label="Built for Shogo"
            onPress={() => setFilterFeatured((v) => !v)}
          />
          <FilterPill
            active={filterFree}
            icon={<Sparkles size={12} color={filterFree ? '#22c55e' : '#71717a'} />}
            label="Free only"
            onPress={() => setFilterFree((v) => !v)}
          />
        </ScrollView>
      </View>

      {/* Content */}
      {loading && listings.length === 0 ? (
        <View className="flex-1">
          <BrowseSkeleton />
        </View>
      ) : error && listings.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-foreground font-medium mb-1">Something went wrong</Text>
          <Text className="text-muted-foreground text-sm text-center mb-4">
            {error}
          </Text>
          <Pressable
            onPress={() => loadGrid(1)}
            className="bg-primary px-4 py-2 rounded-lg"
          >
            <Text className="text-primary-foreground text-sm font-medium">Try again</Text>
          </Pressable>
        </View>
      ) : (
        viewMode === 'grid' ? (
          <FlatList
            ref={browseListRef}
            key={`grid-${numColumns}-${sortMode}-${browseFocus ?? 'home'}`}
            data={paddedData}
            keyExtractor={(item, index) => item?.slug ?? `spacer-${index}`}
            renderItem={renderGridItem}
            extraData={`${sortMode}-${browseFocus ?? 'home'}`}
            numColumns={numColumns}
            columnWrapperStyle={numColumns > 1 ? { gap: 0 } : undefined}
            contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 12 }}
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
                <View className="items-center justify-center py-20 px-6">
                  <Search size={32} color="#a1a1aa" />
                  <Text className="text-foreground font-medium mt-3 mb-1">
                    No agents found
                  </Text>
                  <Text className="text-muted-foreground text-sm text-center mb-4">
                    {isSearching
                      ? `No results for “${debouncedSearchTrimmed}”`
                      : 'Nothing matches the current filters yet.'}
                  </Text>
                  {(filterFeatured || filterFree || activeCategory !== 'all') && (
                    <Pressable
                      onPress={() => {
                        setFilterFeatured(false)
                        setFilterFree(false)
                        setActiveCategory('all')
                      }}
                      className="border border-border rounded-lg px-3 py-1.5"
                    >
                      <Text className="text-xs font-medium text-foreground">
                        Clear filters
                      </Text>
                    </Pressable>
                  )}
                </View>
              ) : null
            }
          />
        ) : (
          <FlatList
            ref={browseListRef}
            key={`list-${sortMode}-${browseFocus ?? 'home'}`}
            data={tileListings}
            keyExtractor={(item) => item.slug}
            renderItem={renderListItem}
            extraData={`${sortMode}-${browseFocus ?? 'home'}`}
            contentContainerStyle={{ paddingBottom: 32 }}
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
                <View className="items-center justify-center py-20 px-6">
                  <Search size={32} color="#a1a1aa" />
                  <Text className="text-foreground font-medium mt-3 mb-1">
                    No agents found
                  </Text>
                  <Text className="text-muted-foreground text-sm text-center mb-4">
                    {isSearching
                      ? `No results for “${debouncedSearchTrimmed}”`
                      : 'Nothing matches the current filters yet.'}
                  </Text>
                  {(filterFeatured || filterFree || activeCategory !== 'all') && (
                    <Pressable
                      onPress={() => {
                        setFilterFeatured(false)
                        setFilterFree(false)
                        setActiveCategory('all')
                      }}
                      className="border border-border rounded-lg px-3 py-1.5"
                    >
                      <Text className="text-xs font-medium text-foreground">
                        Clear filters
                      </Text>
                    </Pressable>
                  )}
                </View>
              ) : null
            }
          />
        )
      )}
    </View>
  )
})

// ── Sub-components ─────────────────────────────────────────────────

function AgentCollectionSection({
  viewMode,
  title,
  subtitle,
  items,
  onSeeAll,
  onPress,
  railTileSize = 'medium',
  railItemWidth = 220,
}: {
  viewMode: ViewMode
  title: string
  subtitle: string
  items: ListingFromAPI[]
  onSeeAll?: () => void
  onPress: (slug: string) => void
  railTileSize?: 'featured' | 'medium'
  railItemWidth?: number
}) {
  return (
    <View className="mb-8">
      <View className="relative z-20 bg-background">
        <SectionHeader title={title} subtitle={subtitle} onSeeAll={onSeeAll} />
      </View>
      {viewMode === 'grid' ? (
        <HorizontalRail
          items={items}
          keyExtractor={(item) => item.slug}
          itemWidth={railItemWidth}
          renderItem={(item) => (
            <AgentTile
              size={railTileSize}
              listing={toTileListing(item)}
              onPress={() => onPress(item.slug)}
            />
          )}
        />
      ) : (
        <View className="px-5 gap-3">
          {items.map((item) => (
            <AgentTile
              key={item.slug}
              size="compact"
              listing={toTileListing(item)}
              onPress={() => onPress(item.slug)}
            />
          ))}
        </View>
      )}
    </View>
  )
}

function CategoryPill({
  active,
  label,
  onPress,
}: {
  active: boolean
  label: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full px-3.5 h-8 items-center justify-center border ${
        active ? 'bg-primary border-primary' : 'bg-card border-border'
      }`}
    >
      <Text
        className={`text-xs font-medium ${
          active ? 'text-primary-foreground' : 'text-foreground'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function FilterPill({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center gap-1.5 rounded-full px-3 h-8 border ${
        active ? 'bg-primary/10 border-primary/40' : 'bg-card border-border'
      }`}
    >
      {icon}
      <Text
        className={`text-xs font-medium ${
          active ? 'text-primary' : 'text-foreground'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function SortMenu({
  value,
  open,
  onOpenChange,
  onChange,
}: {
  value: SortMode
  open: boolean
  onOpenChange: (v: boolean) => void
  onChange: (v: SortMode) => void
}) {
  return (
    <Popover
      placement="bottom right"
      isOpen={open}
      onOpen={() => onOpenChange(true)}
      onClose={() => onOpenChange(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          className="flex-row items-center gap-1.5 px-3 h-11 rounded-xl border border-input bg-card"
        >
          <Text className="text-xs font-medium text-foreground">
            {SORT_LABELS[value]}
          </Text>
          <ChevronDown size={12} color="#71717a" />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="p-0 min-w-[160px]">
        <PopoverBody>
          {(Object.keys(SORT_LABELS) as SortMode[]).map((k) => (
            <Pressable
              key={k}
              onPress={() => onChange(k)}
              className={cn('px-3 py-2 active:bg-muted', k === value && 'bg-accent')}
            >
              <Text
                className={cn(
                  'text-xs',
                  k === value ? 'text-foreground font-medium' : 'text-foreground',
                )}
              >
                {SORT_LABELS[k]}
              </Text>
            </Pressable>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode
  onChange: (v: ViewMode) => void
}) {
  return (
    <View className="flex-row items-center rounded-xl border border-border bg-card overflow-hidden h-11">
      <Pressable
        onPress={() => onChange('grid')}
        className={`px-3 h-full items-center justify-center ${
          value === 'grid' ? 'bg-muted' : ''
        }`}
        accessibilityLabel="Grid view"
      >
        <Grid3X3 size={14} color={value === 'grid' ? '#e27927' : '#71717a'} />
      </Pressable>
      <View className="w-px h-5 bg-border" />
      <Pressable
        onPress={() => onChange('list')}
        className={`px-3 h-full items-center justify-center ${
          value === 'list' ? 'bg-muted' : ''
        }`}
        accessibilityLabel="List view"
      >
        <List size={14} color={value === 'list' ? '#e27927' : '#71717a'} />
      </Pressable>
    </View>
  )
}

function CategoryCard({
  category,
  numColumns,
  onPress,
}: {
  category: MarketplaceCategory
  numColumns: number
  onPress: () => void
}) {
  const Icon = getLucideIcon(category.icon)
  // Map device columns to category-grid columns. We always show at least 2.
  const cols = numColumns === 1 ? 2 : numColumns >= 4 ? 4 : numColumns
  const widthPct = `${(100 - (cols - 1) * 3) / cols}%`
  return (
    <Pressable
      onPress={onPress}
      className="rounded-2xl overflow-hidden border border-border active:opacity-90"
      style={{
        width: widthPct as any,
        minWidth: 150,
        backgroundColor: `${category.accent}14`,
      }}
    >
      <View className="px-4 py-5 gap-1.5">
        <View
          className="rounded-full w-9 h-9 items-center justify-center mb-1"
          style={{ backgroundColor: `${category.accent}33` }}
        >
          <Icon size={16} color={category.accent} />
        </View>
        <Text className="text-base font-semibold text-foreground">{category.label}</Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={2}>
          {category.tagline}
        </Text>
      </View>
    </Pressable>
  )
}

function CreatorRailCard({
  creator,
  onPress,
}: {
  creator: LeaderboardCreator
  onPress: () => void
}) {
  const tierColor: Record<CreatorTier, string> = {
    newcomer: '#9ca3af',
    builder: '#3b82f6',
    craftsman: '#22c55e',
    expert: '#a855f7',
    master: '#eab308',
  }
  const initial = creator.displayName.charAt(0).toUpperCase()
  return (
    <Pressable
      onPress={onPress}
      className="rounded-2xl border border-border bg-card p-4 gap-3 active:opacity-90"
    >
      <View className="flex-row items-center gap-3">
        {creator.avatarUrl ? (
          <Image
            source={{ uri: creator.avatarUrl }}
            style={{ width: 44, height: 44, borderRadius: 999 }}
          />
        ) : (
          <View
            className="rounded-full items-center justify-center"
            style={{
              width: 44,
              height: 44,
              backgroundColor: `${tierColor[creator.creatorTier]}33`,
            }}
          >
            <Text
              style={{
                color: tierColor[creator.creatorTier],
                fontWeight: '700',
                fontSize: 18,
              }}
            >
              {initial}
            </Text>
          </View>
        )}
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {creator.displayName}
          </Text>
          <Text className="text-[11px] text-muted-foreground capitalize">
            {creator.creatorTier} · {creator.reputationScore} rep
          </Text>
        </View>
      </View>
      <View className="flex-row items-center gap-3">
        <View>
          <Text className="text-xs font-semibold text-foreground">
            {creator.totalAgentsPublished}
          </Text>
          <Text className="text-[10px] text-muted-foreground">agents</Text>
        </View>
        <View>
          <Text className="text-xs font-semibold text-foreground">
            {formatCount(creator.totalInstalls)}
          </Text>
          <Text className="text-[10px] text-muted-foreground">installs</Text>
        </View>
      </View>
    </Pressable>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function BrowseSkeleton() {
  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 20, gap: 24 }}>
      <View className="h-44 rounded-3xl bg-muted/40" />
      <View className="gap-3">
        <View className="h-5 w-40 rounded bg-muted/40" />
        <View className="flex-row gap-3">
          {[0, 1, 2].map((i) => (
            <View key={i} className="flex-1 h-44 rounded-2xl bg-muted/40" />
          ))}
        </View>
      </View>
      <View className="gap-3">
        <View className="h-5 w-32 rounded bg-muted/40" />
        <View className="flex-row gap-3">
          {[0, 1, 2, 3].map((i) => (
            <View key={i} className="flex-1 h-40 rounded-2xl bg-muted/40" />
          ))}
        </View>
      </View>
    </ScrollView>
  )
}
