// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter, useLocalSearchParams } from 'expo-router'
import {
  ArrowLeft,
  Star,
  Download,
  Shield,
  ExternalLink,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { useAuth } from '../../../contexts/auth'
import { PricingBadge } from '../../../components/marketplace/PricingBadge'
import {
  CreatorBadge,
  TIER_COLORS,
  type CreatorTier,
} from '../../../components/marketplace/CreatorBadge'

interface CreatorFromAPI {
  id: string
  displayName: string
  bio?: string | null
  avatarUrl?: string | null
  creatorTier: CreatorTier
  reputationScore: number
  verified: boolean
  totalAgentsPublished: number
  totalInstalls: number
}

interface ListingDetail {
  id: string
  slug: string
  title: string
  shortDescription: string
  longDescription?: string | null
  category?: string | null
  tags: string[]
  iconUrl?: string | null
  screenshotUrls: string[]
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  installCount: number
  averageRating: number
  reviewCount: number
  currentVersion: string
  creator: CreatorFromAPI
}

interface Review {
  id: string
  userId: string
  rating: number
  title?: string | null
  body?: string | null
  createdAt: string
}

interface ReviewsResponse {
  items: Review[]
  total: number
  page: number
  limit: number
  totalPages: number
}

interface InstallResponse {
  ok: boolean
  projectId?: string
  checkoutUrl?: string
  error?: string
}

function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

function renderStars(rating: number) {
  const stars = []
  const full = Math.floor(rating)
  const half = rating - full >= 0.5
  for (let i = 0; i < 5; i++) {
    const filled = i < full || (i === full && half)
    stars.push(
      <Star
        key={i}
        size={14}
        fill={filled ? '#eab308' : 'transparent'}
        color={filled ? '#eab308' : '#d1d5db'}
      />,
    )
  }
  return stars
}

function timeAgo(dateStr: string): string {
  try {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    const months = Math.floor(days / 30)
    return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
  } catch {
    return ''
  }
}

const ACCENT_COLORS = [
  '#8b5cf6', '#ec4899', '#f97316', '#22c55e',
  '#06b6d4', '#7c3aed', '#d946ef', '#14b8a6',
]

function getAccentColor(title: string): string {
  const idx = title.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % ACCENT_COLORS.length
  return ACCENT_COLORS[idx]
}

export default observer(function MarketplaceDetailScreen() {
  const router = useRouter()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const http = useDomainHttp()
  const { user } = useAuth()

  const [listing, setListing] = useState<ListingDetail | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const loadListing = useCallback(async () => {
    if (!slug) return
    try {
      setLoading(true)
      const res = await http.get<{ listing: ListingDetail }>(`/api/marketplace/${slug}`)
      setListing(res.data.listing)
      setError(null)
    } catch (err: any) {
      console.error('[MarketplaceDetail] Failed to load listing:', err)
      setError('Failed to load listing')
    } finally {
      setLoading(false)
    }
  }, [http, slug])

  const loadReviews = useCallback(async () => {
    if (!slug) return
    try {
      const res = await http.get<ReviewsResponse>(`/api/marketplace/${slug}/reviews?limit=5`)
      setReviews(res.data.items)
    } catch (err) {
      console.error('[MarketplaceDetail] Failed to load reviews:', err)
    }
  }, [http, slug])

  useEffect(() => {
    loadListing()
    loadReviews()
  }, [slug])

  const handleInstall = useCallback(async () => {
    if (!listing || !user?.id) {
      Alert.alert('Sign in required', 'You need to be signed in to install agents.')
      return
    }
    try {
      setInstalling(true)
      const res = await http.post<InstallResponse>(`/api/marketplace/${slug}/install`, {
        workspaceId: user.id,
      })
      const data = res.data
      if (data.checkoutUrl) {
        await Linking.openURL(data.checkoutUrl)
      } else if (data.projectId) {
        router.push(`/(app)/projects/${data.projectId}` as any)
      } else if (data.error) {
        Alert.alert('Install failed', data.error)
      }
    } catch (err: any) {
      console.error('[MarketplaceDetail] Install failed:', err)
      Alert.alert('Install failed', err?.message || 'Something went wrong')
    } finally {
      setInstalling(false)
    }
  }, [listing, user?.id, http, slug, router])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
        <Text className="text-muted-foreground mt-3 text-sm">Loading...</Text>
      </View>
    )
  }

  if (error || !listing) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Text className="text-foreground font-medium mb-1">
          {error || 'Listing not found'}
        </Text>
        <Pressable
          onPress={() => router.back()}
          className="mt-4 bg-primary px-4 py-2 rounded-lg"
        >
          <Text className="text-primary-foreground text-sm font-medium">Go back</Text>
        </Pressable>
      </View>
    )
  }

  const color = getAccentColor(listing.title)
  const initial = listing.title.charAt(0).toUpperCase()
  const tierColor = TIER_COLORS[listing.creator.creatorTier] ?? TIER_COLORS.newcomer

  let installLabel: string
  if (listing.pricingModel === 'free') {
    installLabel = 'Install Free'
  } else if (listing.pricingModel === 'subscription' && listing.monthlyPriceInCents) {
    installLabel = `Subscribe ${formatCents(listing.monthlyPriceInCents)}/mo`
  } else if (listing.priceInCents) {
    installLabel = `Purchase ${formatCents(listing.priceInCents)}`
  } else {
    installLabel = 'Install Free'
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-4 pt-3 pb-2">
        <Pressable onPress={() => router.back()} className="p-1">
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-semibold text-foreground flex-1" numberOfLines={1}>
          {listing.title}
        </Text>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="pb-32">
        {/* Agent icon + title section */}
        <View className="px-4 py-4">
          <View className="flex-row gap-4">
            {listing.iconUrl ? (
              <Image
                source={{ uri: listing.iconUrl }}
                className="w-20 h-20 rounded-2xl"
                resizeMode="cover"
              />
            ) : (
              <View
                className="w-20 h-20 rounded-2xl items-center justify-center"
                style={{ backgroundColor: `${color}22` }}
              >
                <Text style={{ color, fontSize: 28, fontWeight: '700' }}>{initial}</Text>
              </View>
            )}
            <View className="flex-1 justify-center gap-1.5">
              <Text className="text-xl font-bold text-foreground">{listing.title}</Text>
              <Text className="text-sm text-muted-foreground">{listing.shortDescription}</Text>
              <View className="flex-row items-center gap-3 mt-1">
                <PricingBadge
                  pricingModel={listing.pricingModel}
                  priceInCents={listing.priceInCents}
                  monthlyPriceInCents={listing.monthlyPriceInCents}
                />
                {listing.category && (
                  <View className="rounded-full bg-muted px-2 py-0.5">
                    <Text className="text-[11px] text-muted-foreground capitalize">
                      {listing.category}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </View>

        {/* Stats row */}
        <View className="flex-row px-4 gap-6 pb-4">
          <View className="items-center">
            <View className="flex-row items-center gap-1">
              {renderStars(listing.averageRating)}
            </View>
            <Text className="text-xs text-muted-foreground mt-0.5">
              {listing.averageRating.toFixed(1)} ({listing.reviewCount})
            </Text>
          </View>
          <View className="items-center">
            <View className="flex-row items-center gap-1">
              <Download size={16} className="text-muted-foreground" />
              <Text className="text-sm font-medium text-foreground">
                {listing.installCount.toLocaleString()}
              </Text>
            </View>
            <Text className="text-xs text-muted-foreground mt-0.5">installs</Text>
          </View>
          <View className="items-center">
            <Text className="text-sm font-medium text-foreground">v{listing.currentVersion}</Text>
            <Text className="text-xs text-muted-foreground mt-0.5">version</Text>
          </View>
        </View>

        {/* Creator card */}
        <View className="mx-4 mb-4 p-3 rounded-xl border border-border bg-card">
          <View className="flex-row items-center gap-3">
            {listing.creator.avatarUrl ? (
              <Image
                source={{ uri: listing.creator.avatarUrl }}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <View
                className="w-10 h-10 rounded-full items-center justify-center"
                style={{ backgroundColor: `${tierColor}22` }}
              >
                <Text style={{ color: tierColor, fontSize: 16, fontWeight: '600' }}>
                  {listing.creator.displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            <View className="flex-1">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-semibold text-foreground">
                  {listing.creator.displayName}
                </Text>
                {listing.creator.verified && (
                  <Shield size={12} className="text-blue-500" />
                )}
              </View>
              <View className="flex-row items-center gap-2 mt-0.5">
                <CreatorBadge
                  tier={listing.creator.creatorTier}
                  displayName={listing.creator.creatorTier}
                />
                <Text className="text-xs text-muted-foreground">
                  {listing.creator.reputationScore} rep
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Screenshots */}
        {listing.screenshotUrls.length > 0 && (
          <View className="mb-4">
            <Text className="text-sm font-semibold text-foreground px-4 mb-2">Screenshots</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="px-4 gap-3"
            >
              {listing.screenshotUrls.map((url, i) => (
                <Image
                  key={i}
                  source={{ uri: url }}
                  className="w-64 h-40 rounded-xl bg-muted"
                  resizeMode="cover"
                />
              ))}
            </ScrollView>
          </View>
        )}

        {/* Description */}
        {listing.longDescription && (
          <View className="px-4 mb-4">
            <Text className="text-sm font-semibold text-foreground mb-2">About</Text>
            <Text className="text-sm text-muted-foreground leading-5">
              {listing.longDescription}
            </Text>
          </View>
        )}

        {/* Tags */}
        {listing.tags.length > 0 && (
          <View className="px-4 mb-4">
            <View className="flex-row flex-wrap gap-1.5">
              {listing.tags.map((tag) => (
                <View key={tag} className="rounded-full bg-muted px-2.5 py-1">
                  <Text className="text-xs text-muted-foreground">{tag}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Reviews */}
        <View className="px-4 mb-4">
          <Text className="text-sm font-semibold text-foreground mb-3">
            Reviews ({listing.reviewCount})
          </Text>
          {reviews.length === 0 ? (
            <Text className="text-sm text-muted-foreground">No reviews yet.</Text>
          ) : (
            <View className="gap-3">
              {reviews.map((review) => (
                <View
                  key={review.id}
                  className="p-3 rounded-xl border border-border bg-card"
                >
                  <View className="flex-row items-center justify-between mb-1">
                    <View className="flex-row items-center gap-1">
                      {renderStars(review.rating)}
                    </View>
                    <Text className="text-[10px] text-muted-foreground">
                      {timeAgo(review.createdAt)}
                    </Text>
                  </View>
                  {review.title && (
                    <Text className="text-sm font-medium text-foreground mb-0.5">
                      {review.title}
                    </Text>
                  )}
                  {review.body && (
                    <Text className="text-xs text-muted-foreground leading-4">
                      {review.body}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Install button - fixed bottom */}
      <View className="absolute bottom-0 left-0 right-0 bg-background border-t border-border px-4 py-3 pb-8">
        <Pressable
          onPress={handleInstall}
          disabled={installing}
          className={`rounded-xl py-3.5 items-center justify-center ${
            installing ? 'bg-primary/60' : 'bg-primary active:bg-primary/80'
          }`}
        >
          {installing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <View className="flex-row items-center gap-2">
              {listing.pricingModel !== 'free' && (
                <ExternalLink size={16} color="#fff" />
              )}
              <Text className="text-primary-foreground font-semibold text-base">
                {installLabel}
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  )
})
