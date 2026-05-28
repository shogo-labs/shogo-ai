// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Marketplace Listings index — paginated browser of every
 * MarketplaceListing row, filterable by status. Status filter chips
 * include "All" plus every value from `ListingStatus` so an admin can
 * find drafts, suspended listings, etc., not just the review queue.
 *
 * Data source: GET /api/admin/marketplace/listings?status&page&limit.
 * Row -> /(admin)/marketplace/listing/:id.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Store,
  Star,
  Download,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

import {
  fetchAdminJson,
  formatRelative,
  STATUS_PILL,
  ALL_LISTING_STATUSES,
  type ListingStatus,
} from './_helpers'

interface AdminListing {
  id: string
  slug: string
  title: string
  shortDescription: string
  iconUrl: string | null
  status: ListingStatus
  currentVersion: string
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents: number | null
  monthlyPriceInCents: number | null
  installCount: number
  averageRating: number
  reviewCount: number
  publishedAt: string | null
  featuredAt: string | null
  updatedAt: string
  creator: {
    id: string
    displayName: string
    user: { id: string; email: string; name: string | null }
  }
}

interface ListingsResponse {
  items: AdminListing[]
  total: number
  page: number
  limit: number
  totalPages: number
}

type StatusFilter = ListingStatus | 'all'

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending_review', label: 'Pending' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Draft' },
  { value: 'in_review', label: 'In review' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'archived', label: 'Archived' },
  { value: 'rejected', label: 'Rejected' },
]

function StatusPill({ status }: { status: ListingStatus }) {
  const pill = STATUS_PILL[status]
  return (
    <View className={cn('flex-row items-center gap-1 px-2 py-0.5 rounded-full', pill.bg)}>
      <View className={cn('h-1.5 w-1.5 rounded-full', pill.dot)} />
      <Text className="text-[10px] font-medium text-foreground">{pill.label}</Text>
    </View>
  )
}

function pricingLabel(l: AdminListing): string {
  if (l.pricingModel === 'free') return 'Free'
  if (l.pricingModel === 'subscription') {
    return l.monthlyPriceInCents != null
      ? `$${(l.monthlyPriceInCents / 100).toFixed(2)}/mo`
      : 'Subscription'
  }
  return l.priceInCents != null ? `$${(l.priceInCents / 100).toFixed(2)}` : 'Paid'
}

export default function MarketplaceListingsPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [filter, setFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ListingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const params: Record<string, string> = { page: String(page), limit: '20' }
    if (filter !== 'all' && (ALL_LISTING_STATUSES as readonly string[]).includes(filter)) {
      params.status = filter
    }
    const result = await fetchAdminJson<ListingsResponse>('/listings', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [filter, page])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const totalPages = data?.totalPages ?? 1

  const renderRow = ({ item }: { item: AdminListing }) => (
    <Pressable
      onPress={() => router.push(`/(admin)/marketplace/listing/${item.id}` as any)}
      className={cn(
        'flex-row items-center border-b border-border active:bg-muted/30',
        isWide ? 'px-4 py-3' : 'p-3',
      )}
    >
      <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center mr-3">
        <Store size={16} className="text-primary" />
      </View>

      <View className={cn('min-w-0 mr-2', isWide ? 'w-[260px]' : 'flex-1')}>
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {item.title}
          </Text>
          {item.featuredAt && <Sparkles size={11} className="text-amber-500" />}
        </View>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {item.creator.displayName} · {item.slug}
        </Text>
      </View>

      <View className="w-[110px] mr-3">
        <StatusPill status={item.status} />
      </View>

      {isWide && (
        <Text className="text-xs text-muted-foreground w-[80px] mr-3" numberOfLines={1}>
          {pricingLabel(item)}
        </Text>
      )}

      {isWide && (
        <View className="flex-row items-center gap-1 w-[70px] mr-3">
          <Download size={11} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {item.installCount.toLocaleString()}
          </Text>
        </View>
      )}

      {isWide && (
        <View className="flex-row items-center gap-1 w-[80px] mr-3">
          <Star size={11} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {item.averageRating.toFixed(2)} ({item.reviewCount})
          </Text>
        </View>
      )}

      <Text className="text-xs text-muted-foreground w-[90px] text-right ml-auto">
        {formatRelative(item.updatedAt)}
      </Text>
    </Pressable>
  )

  const ListHeader = () => (
    <View className="gap-3 mb-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-xl font-semibold text-foreground">Listings</Text>
        {data && (
          <Text className="text-xs text-muted-foreground">
            {data.total} total
          </Text>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingVertical: 2 }}
      >
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.value
          return (
            <Pressable
              key={opt.value}
              onPress={() => {
                setFilter(opt.value)
                setPage(1)
              }}
              className={cn(
                'px-3 py-1.5 rounded-full border',
                active
                  ? 'bg-primary/10 border-primary'
                  : 'bg-card border-border active:bg-muted',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {opt.label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      {isWide && (
        <View className="flex-row items-center bg-muted/50 rounded-t-lg border-b border-border px-4 py-2.5">
          <View className="w-9 mr-3" />
          <Text className="text-xs font-medium text-muted-foreground w-[260px] mr-2">
            Listing
          </Text>
          <Text className="text-xs font-medium text-muted-foreground w-[110px] mr-3">
            Status
          </Text>
          <Text className="text-xs font-medium text-muted-foreground w-[80px] mr-3">
            Pricing
          </Text>
          <Text className="text-xs font-medium text-muted-foreground w-[70px] mr-3">
            Installs
          </Text>
          <Text className="text-xs font-medium text-muted-foreground w-[80px] mr-3">
            Rating
          </Text>
          <Text className="text-xs font-medium text-muted-foreground w-[90px] text-right ml-auto">
            Updated
          </Text>
        </View>
      )}
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className="flex-row items-center justify-between mt-3 px-1">
        <Text className="text-xs text-muted-foreground">{data?.total ?? 0} total</Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className={cn(
              'p-2 rounded-md border border-border',
              page === 1 && 'opacity-30',
            )}
          >
            <ChevronLeft size={16} className="text-foreground" />
          </Pressable>
          <Text className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </Text>
          <Pressable
            onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className={cn(
              'p-2 rounded-md border border-border',
              page >= totalPages && 'opacity-30',
            )}
          >
            <ChevronRight size={16} className="text-foreground" />
          </Pressable>
        </View>
      </View>
    )
  }

  const Empty = () => (
    <View className="items-center justify-center py-16">
      <Store size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">No listings match this filter</Text>
    </View>
  )

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-3')}>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={<ListHeader />}
        ListFooterComponent={<ListFooter />}
        ListEmptyComponent={loading ? null : <Empty />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={renderRow}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      />
      {loading && !refreshing && (
        <View className="absolute inset-0 items-center justify-center bg-background/80">
          <ActivityIndicator size="large" />
        </View>
      )}
    </View>
  )
}
