// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Linking,
  TextInput,
  Modal,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter, useLocalSearchParams } from 'expo-router'
import {
  ArrowLeft,
  Star,
  Download,
  ExternalLink,
  MessageSquarePlus,
  X,
  Info,
  ChevronRight,
  Share2,
  Clock,
  Check,
  ChevronDown,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { useAuth } from '../../../contexts/auth'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import {
  AgentTile,
  type AgentTileListing,
  CreatorChip,
  HorizontalRail,
  IntegrationStrip,
  MarketplaceHero,
  PricingCards,
  QualityBadge,
  SectionHeader,
  StarRating,
  formatCents,
  installCtaLabel,
  getAccentColor,
  getInitial,
  type CreatorTier,
} from '../../../components/marketplace'
import {
  resolvePermissionCopy,
  categoryLabel,
} from '@shogo/shared-app'

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
  averageAgentRating?: number
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
  annualPriceInCents?: number | null
  installCount: number
  averageRating: number
  reviewCount: number
  currentVersion: string
  featuredAt?: string | null
  publishedAt?: string | null
  updatedAt?: string | null
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

interface UserInstall {
  id: string
  listingId: string
  status: string
}

interface RelatedListing {
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

type ReviewSort = 'newest' | 'highest' | 'lowest'

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
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

function toTileListing(item: RelatedListing): AgentTileListing {
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

/**
 * Try to extract bullet points from `longDescription`. Looks for lines
 * starting with `- `, `* `, or `• `. When at least 2 bullets are found,
 * returns them with the leading prose split out separately. Otherwise
 * the whole string is treated as plain prose.
 */
function parseDescription(longDescription: string | null | undefined): {
  prose: string
  bullets: string[]
} {
  if (!longDescription) return { prose: '', bullets: [] }
  const lines = longDescription.split(/\r?\n/)
  const proseLines: string[] = []
  const bullets: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s*[-*•]\s+(.*)$/)
    if (m) bullets.push(m[1].trim())
    else proseLines.push(line)
  }
  if (bullets.length < 2) return { prose: longDescription.trim(), bullets: [] }
  return { prose: proseLines.join('\n').trim(), bullets }
}

export default observer(function MarketplaceDetailScreen() {
  const router = useRouter()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const http = useDomainHttp()
  const { user } = useAuth()
  const activeWorkspace = useActiveWorkspace()
  const { width } = useWindowDimensions()
  const isWide = width >= 768

  const [listing, setListing] = useState<ListingDetail | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewTotal, setReviewTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const [userInstall, setUserInstall] = useState<UserInstall | null>(null)
  const [showReviewForm, setShowReviewForm] = useState(false)
  const [reviewRating, setReviewRating] = useState(5)
  const [reviewTitle, setReviewTitle] = useState('')
  const [reviewBody, setReviewBody] = useState('')
  const [submittingReview, setSubmittingReview] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewFilter, setReviewFilter] = useState<number | null>(null)
  const [reviewSort, setReviewSort] = useState<ReviewSort>('newest')
  const [showAllPermissions, setShowAllPermissions] = useState(false)

  const [moreFromCreator, setMoreFromCreator] = useState<RelatedListing[]>([])
  const [similar, setSimilar] = useState<RelatedListing[]>([])

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [heroVisible, setHeroVisible] = useState(true)
  const heroOffsetRef = useRef(0)

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
      const res = await http.get<ReviewsResponse>(
        `/api/marketplace/${slug}/reviews?limit=50`,
      )
      setReviews(res.data.items)
      setReviewTotal(res.data.total)
    } catch (err) {
      console.error('[MarketplaceDetail] Failed to load reviews:', err)
    }
  }, [http, slug])

  const loadUserInstall = useCallback(async () => {
    if (!user?.id || !listing) return
    try {
      const res = await http.get<{ installs: UserInstall[] }>('/api/marketplace/my-installs')
      const installs = res.data?.installs ?? []
      const match = installs.find((i) => i.listingId === listing.id && i.status === 'active')
      setUserInstall(match ?? null)
    } catch {
      // non-critical
    }
  }, [http, user?.id, listing])

  const loadRelated = useCallback(async () => {
    if (!listing) return
    try {
      const fromCreator = http.get<{ items: RelatedListing[] }>(
        `/api/marketplace?creatorId=${encodeURIComponent(listing.creator.id)}&excludeSlug=${encodeURIComponent(listing.slug)}&limit=6&sort=popular`,
      )
      const sameCategory = listing.category
        ? http.get<{ items: RelatedListing[] }>(
            `/api/marketplace?category=${encodeURIComponent(listing.category)}&excludeSlug=${encodeURIComponent(listing.slug)}&limit=8&sort=popular`,
          )
        : Promise.resolve({ data: { items: [] } })
      const [a, b] = await Promise.all([fromCreator, sameCategory])
      setMoreFromCreator(a.data.items ?? [])
      // Avoid duplicating items between rails
      const fromCreatorSlugs = new Set((a.data.items ?? []).map((i) => i.slug))
      setSimilar(
        ((b as any).data.items ?? []).filter(
          (i: RelatedListing) => !fromCreatorSlugs.has(i.slug),
        ),
      )
    } catch (err) {
      console.error('[MarketplaceDetail] related load failed:', err)
    }
  }, [http, listing])

  useEffect(() => {
    loadListing()
    loadReviews()
  }, [slug])

  useEffect(() => {
    if (listing) {
      loadUserInstall()
      loadRelated()
    }
  }, [listing, loadUserInstall, loadRelated])

  const handleInstall = useCallback(async () => {
    if (!listing || !user?.id || !activeWorkspace?.id) {
      Alert.alert('Sign In Required', 'You need to be signed in to install agents.')
      return
    }
    try {
      setInstalling(true)
      const res = await http.post<InstallResponse>(`/api/marketplace/${slug}/install`, {
        workspaceId: activeWorkspace.id,
      })
      const data = res.data
      if (data.checkoutUrl) {
        await Linking.openURL(data.checkoutUrl)
      } else if (data.projectId) {
        router.push(`/(app)/projects/${data.projectId}` as any)
      } else if (data.error) {
        Alert.alert('Install Failed', data.error)
      }
    } catch (err: any) {
      console.error('[MarketplaceDetail] Install failed:', err)
      Alert.alert('Install Failed', err?.message || 'Something went wrong')
    } finally {
      setInstalling(false)
    }
  }, [listing, user?.id, activeWorkspace?.id, http, slug, router])

  const handleSubmitReview = useCallback(async () => {
    if (!listing || !userInstall) return
    setSubmittingReview(true)
    setReviewError(null)
    try {
      await http.post(`/api/marketplace/${slug}/reviews`, {
        installId: userInstall.id,
        rating: reviewRating,
        title: reviewTitle.trim() || null,
        body: reviewBody.trim() || null,
      })
      setShowReviewForm(false)
      setReviewTitle('')
      setReviewBody('')
      setReviewRating(5)
      loadReviews()
      loadListing()
    } catch (err: any) {
      const msg = err?.message || err?.data?.error || 'Failed to submit review'
      setReviewError(
        msg.includes('already reviewed')
          ? 'You have already reviewed this agent.'
          : msg,
      )
    } finally {
      setSubmittingReview(false)
    }
  }, [
    listing,
    userInstall,
    slug,
    http,
    reviewRating,
    reviewTitle,
    reviewBody,
    loadReviews,
    loadListing,
  ])

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y
      // Reveal sticky CTA once the user scrolls past the hero block.
      const threshold = heroOffsetRef.current || 320
      setHeroVisible(y < threshold)
    },
    [],
  )

  // ── Derived data ─────────────────────────────────────────────────
  const ratingHistogram = useMemo(() => {
    const counts = [0, 0, 0, 0, 0]
    for (const r of reviews) {
      if (r.rating >= 1 && r.rating <= 5) counts[r.rating - 1] += 1
    }
    const total = reviews.length || 1
    return counts.map((c) => ({ count: c, pct: (c / total) * 100 }))
  }, [reviews])

  const filteredReviews = useMemo(() => {
    let list = reviews.slice()
    if (reviewFilter != null) list = list.filter((r) => r.rating === reviewFilter)
    list.sort((a, b) => {
      if (reviewSort === 'newest')
        return +new Date(b.createdAt) - +new Date(a.createdAt)
      if (reviewSort === 'highest') return b.rating - a.rating
      return a.rating - b.rating
    })
    return list
  }, [reviews, reviewFilter, reviewSort])

  const description = useMemo(
    () => parseDescription(listing?.longDescription),
    [listing?.longDescription],
  )

  const permissions = useMemo(() => {
    if (!listing) return []
    const seen = new Set<string>()
    const out: { tag: string; copy: string }[] = []
    for (const tag of listing.tags) {
      const c = resolvePermissionCopy(tag)
      if (c && !seen.has(c)) {
        seen.add(c)
        out.push({ tag, copy: c })
      }
    }
    return out
  }, [listing])

  if (loading) {
    return (
      <View className="flex-1 bg-background">
        <DetailSkeleton />
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
          <Text className="text-primary-foreground text-sm font-medium">Go Back</Text>
        </Pressable>
      </View>
    )
  }

  const accent = getAccentColor(listing.title)
  const initial = getInitial(listing.title)
  const isPaid = listing.pricingModel !== 'free'
  const ctaLabel = installCtaLabel(
    listing.pricingModel,
    listing.priceInCents,
    listing.monthlyPriceInCents,
    listing.annualPriceInCents,
  )

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1" numberOfLines={1}>
          {listing.title}
        </Text>
        <Pressable hitSlop={6} className="p-1.5 active:opacity-60">
          <Share2 size={18} color="#71717a" />
        </Pressable>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        onScroll={onScroll}
        scrollEventThrottle={32}
      >
        {/* Hero */}
        <View
          onLayout={(e) => (heroOffsetRef.current = e.nativeEvent.layout.height)}
        >
          <MarketplaceHero
            accent={accent}
            title={listing.title}
            subtitle={listing.shortDescription}
            trailing={
              <View
                className="rounded-2xl items-center justify-center"
                style={{
                  width: 88,
                  height: 88,
                  backgroundColor: `${accent}33`,
                }}
              >
                {listing.iconUrl ? (
                  <Image
                    source={{ uri: listing.iconUrl }}
                    style={{ width: 64, height: 64, borderRadius: 14 }}
                    resizeMode="cover"
                  />
                ) : (
                  <Text style={{ color: accent, fontSize: 36, fontWeight: '700' }}>
                    {initial}
                  </Text>
                )}
              </View>
            }
          >
            <View className="gap-3">
              <View className="flex-row items-center gap-2 flex-wrap">
                {listing.featuredAt && <QualityBadge size="sm" />}
                {listing.category && (
                  <View className="rounded-full bg-foreground/10 px-2.5 py-1">
                    <Text className="text-[11px] font-medium text-foreground/80">
                      {categoryLabel(listing.category)}
                    </Text>
                  </View>
                )}
              </View>
              <CreatorChip
                creatorId={listing.creator.id}
                displayName={listing.creator.displayName}
                tier={listing.creator.creatorTier}
                avatarUrl={listing.creator.avatarUrl}
                verified={listing.creator.verified}
                size="sm"
              />
              <View className="flex-row items-center gap-4">
                <View className="flex-row items-center gap-1">
                  <StarRating rating={listing.averageRating} size={13} />
                  <Text className="text-xs text-foreground/80 ml-1">
                    {listing.averageRating > 0
                      ? listing.averageRating.toFixed(1)
                      : '—'}{' '}
                    ({listing.reviewCount})
                  </Text>
                </View>
                <View className="flex-row items-center gap-1">
                  <Download size={12} color="#71717a" />
                  <Text className="text-xs text-foreground/80">
                    {listing.installCount.toLocaleString()} installs
                  </Text>
                </View>
                {listing.updatedAt && (
                  <View className="flex-row items-center gap-1">
                    <Clock size={12} color="#71717a" />
                    <Text className="text-xs text-foreground/80">
                      Updated {timeAgo(listing.updatedAt)}
                    </Text>
                  </View>
                )}
              </View>
              <View className="flex-row items-center gap-3 mt-2">
                <Pressable
                  onPress={handleInstall}
                  disabled={installing}
                  className={`rounded-xl px-5 py-3 flex-row items-center gap-2 ${
                    installing ? 'bg-primary/60' : 'bg-primary active:opacity-90'
                  }`}
                  style={{ minWidth: 200 }}
                >
                  {installing ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      {isPaid && <ExternalLink size={14} color="#fff" />}
                      <Text className="text-sm font-semibold text-primary-foreground">
                        {ctaLabel}
                      </Text>
                    </>
                  )}
                </Pressable>
                {!!userInstall && (
                  <View className="flex-row items-center gap-1">
                    <Check size={14} color="#22c55e" />
                    <Text className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      Installed
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </MarketplaceHero>
        </View>

        {/* Screenshots gallery */}
        {listing.screenshotUrls.length > 0 && (
          <View className="mt-8 mb-8">
            <SectionHeader title="Screenshots" padded />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              snapToInterval={isWide ? 540 : 320}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {listing.screenshotUrls.map((url, i) => (
                <Pressable
                  key={`${url}-${i}`}
                  onPress={() => setLightboxIndex(i)}
                  className="rounded-2xl overflow-hidden border border-border bg-muted active:opacity-90"
                  style={{
                    width: isWide ? 520 : 300,
                    height: isWide ? 320 : 200,
                  }}
                >
                  <Image
                    source={{ uri: url }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* About + What's included */}
        {(description.prose || description.bullets.length > 0) && (
          <View className="px-5 mb-8 max-w-2xl gap-5">
            <View>
              <Text className="text-base font-semibold text-foreground mb-2">About</Text>
              {description.prose ? (
                <Text className="text-sm text-foreground/80 leading-6">
                  {description.prose}
                </Text>
              ) : (
                <Text className="text-sm text-foreground/80 leading-6">
                  {listing.shortDescription}
                </Text>
              )}
            </View>
            {description.bullets.length > 0 && (
              <View>
                <Text className="text-base font-semibold text-foreground mb-2">
                  What&apos;s included
                </Text>
                <View className="gap-2">
                  {description.bullets.map((b, i) => (
                    <View key={i} className="flex-row items-start gap-2">
                      <View className="rounded-full bg-emerald-500/15 mt-0.5 p-0.5">
                        <Check size={12} color="#22c55e" />
                      </View>
                      <Text className="text-sm text-foreground/80 flex-1 leading-5">
                        {b}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}

        {/* Works with */}
        {listing.tags.length > 0 && (
          <View className="px-5 mb-8 max-w-3xl">
            <Text className="text-base font-semibold text-foreground mb-3">Works with</Text>
            <IntegrationStrip tags={listing.tags} />
          </View>
        )}

        {/* This agent uses (positive permissions) */}
        {permissions.length > 0 && (
          <View className="px-5 mb-8 max-w-2xl">
            <Text className="text-base font-semibold text-foreground mb-3">
              This agent uses
            </Text>
            <View className="rounded-2xl border border-border bg-card p-4 gap-2.5">
              {(showAllPermissions ? permissions : permissions.slice(0, 4)).map((p) => (
                <View key={p.tag} className="flex-row items-start gap-2.5">
                  <View className="rounded-full bg-primary/15 mt-0.5 p-1">
                    <Check size={10} color="#e27927" />
                  </View>
                  <Text className="text-sm text-foreground/85 flex-1 leading-5">
                    {p.copy}
                  </Text>
                </View>
              ))}
              {permissions.length > 4 && !showAllPermissions && (
                <Pressable
                  onPress={() => setShowAllPermissions(true)}
                  className="flex-row items-center gap-1 mt-1 active:opacity-60"
                >
                  <Text className="text-xs font-medium text-primary">
                    Show all {permissions.length}
                  </Text>
                  <ChevronDown size={12} color="#e27927" />
                </Pressable>
              )}
            </View>
          </View>
        )}

        {/* Pricing */}
        <View className="px-5 mb-8 max-w-3xl">
          <Text className="text-base font-semibold text-foreground mb-3">Pricing</Text>
          <PricingCards
            pricingModel={listing.pricingModel}
            priceInCents={listing.priceInCents}
            monthlyPriceInCents={listing.monthlyPriceInCents}
            annualPriceInCents={listing.annualPriceInCents}
            onSelect={() => handleInstall()}
            loading={installing}
          />
          {isPaid && (
            <Text className="text-xs text-muted-foreground mt-3 text-center">
              Payment processed by Stripe · Cancel anytime
            </Text>
          )}
        </View>

        {/* Created by */}
        <View className="px-5 mb-8 max-w-2xl">
          <Text className="text-base font-semibold text-foreground mb-3">Created by</Text>
          <Pressable
            onPress={() =>
              router.push(`/(app)/marketplace/creators/${listing.creator.id}` as any)
            }
            className="rounded-2xl border border-border bg-card p-4 active:opacity-90"
          >
            <View className="flex-row items-center gap-3 mb-3">
              <CreatorChip
                displayName={listing.creator.displayName}
                tier={listing.creator.creatorTier}
                avatarUrl={listing.creator.avatarUrl}
                verified={listing.creator.verified}
                size="lg"
                disablePress
              />
              <View className="ml-auto">
                <ChevronRight size={16} color="#71717a" />
              </View>
            </View>
            <View className="flex-row items-center gap-5 mb-2">
              <CreatorStat label="Agents" value={String(listing.creator.totalAgentsPublished)} />
              <CreatorStat
                label="Installs"
                value={listing.creator.totalInstalls.toLocaleString()}
              />
              <CreatorStat
                label="Avg rating"
                value={
                  listing.creator.averageAgentRating &&
                  listing.creator.averageAgentRating > 0
                    ? listing.creator.averageAgentRating.toFixed(1)
                    : '—'
                }
              />
              <CreatorStat label="Reputation" value={String(listing.creator.reputationScore)} />
            </View>
            {listing.creator.bio && (
              <Text className="text-sm text-foreground/70 leading-5 mt-1">
                {listing.creator.bio}
              </Text>
            )}
          </Pressable>
        </View>

        {/* Ratings & reviews */}
        <View className="px-5 mb-8 max-w-3xl">
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-base font-semibold text-foreground">
              Ratings & reviews
            </Text>
            {userInstall && !showReviewForm && (
              <Pressable
                onPress={() => setShowReviewForm(true)}
                className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary"
              >
                <MessageSquarePlus size={13} color="#fff" />
                <Text className="text-xs font-semibold text-primary-foreground">
                  Write review
                </Text>
              </Pressable>
            )}
          </View>

          {/* Review form */}
          {showReviewForm && (
            <View className="mb-5 p-4 rounded-2xl border border-primary/30 bg-primary/5 gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-semibold text-foreground">Your review</Text>
                <Pressable onPress={() => setShowReviewForm(false)} hitSlop={6}>
                  <X size={16} color="#71717a" />
                </Pressable>
              </View>
              <View>
                <Text className="text-xs text-muted-foreground mb-1.5">Rating</Text>
                <StarRating
                  rating={reviewRating}
                  onChange={setReviewRating}
                  size={28}
                  gap={4}
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground mb-1.5">Title (optional)</Text>
                <TextInput
                  value={reviewTitle}
                  onChangeText={setReviewTitle}
                  placeholder="Summarize your experience"
                  placeholderTextColor="#9ca3af"
                  className="px-3 py-2.5 rounded-lg border border-border bg-card text-foreground text-sm"
                />
              </View>
              <View>
                <Text className="text-xs text-muted-foreground mb-1.5">Review (optional)</Text>
                <TextInput
                  value={reviewBody}
                  onChangeText={setReviewBody}
                  placeholder="What did you like or dislike about this agent?"
                  placeholderTextColor="#9ca3af"
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  className="px-3 py-2.5 rounded-lg border border-border bg-card text-foreground text-sm min-h-[80px]"
                />
              </View>
              {reviewError && (
                <Text className="text-xs text-destructive">{reviewError}</Text>
              )}
              <Pressable
                onPress={handleSubmitReview}
                disabled={submittingReview}
                className={`py-2.5 rounded-lg items-center ${
                  submittingReview ? 'bg-primary/60' : 'bg-primary'
                }`}
              >
                {submittingReview ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text className="text-sm font-semibold text-primary-foreground">
                    Submit review
                  </Text>
                )}
              </Pressable>
            </View>
          )}

          {!userInstall && !showReviewForm && (
            <View className="flex-row items-start gap-2 mb-4 px-3 py-2.5 rounded-lg bg-muted/50">
              <Info size={14} color="#71717a" />
              <Text className="text-xs text-muted-foreground flex-1">
                Install this agent to leave a review.
              </Text>
            </View>
          )}

          {reviewTotal > 0 && (
            <View className={`gap-4 mb-5 ${isWide ? 'flex-row' : ''}`}>
              {/* Aggregate */}
              <View
                className="rounded-2xl border border-border bg-card p-4 items-center justify-center"
                style={isWide ? { width: 220 } : undefined}
              >
                <Text className="text-4xl font-bold text-foreground">
                  {listing.averageRating.toFixed(1)}
                </Text>
                <View className="my-1">
                  <StarRating rating={listing.averageRating} size={16} />
                </View>
                <Text className="text-xs text-muted-foreground">
                  Based on {reviewTotal} review{reviewTotal === 1 ? '' : 's'}
                </Text>
              </View>
              {/* Histogram */}
              <View className="flex-1 rounded-2xl border border-border bg-card p-4 gap-2">
                {[5, 4, 3, 2, 1].map((row) => {
                  const data = ratingHistogram[row - 1]
                  const isActive = reviewFilter === row
                  return (
                    <Pressable
                      key={row}
                      onPress={() => setReviewFilter(isActive ? null : row)}
                      className="flex-row items-center gap-3 active:opacity-70"
                    >
                      <Text className="text-xs text-muted-foreground w-3">{row}</Text>
                      <Star size={12} fill="#eab308" color="#eab308" />
                      <View className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <View
                          className={isActive ? 'bg-primary' : 'bg-yellow-400'}
                          style={{
                            width: `${data.pct}%`,
                            height: '100%',
                          }}
                        />
                      </View>
                      <Text className="text-[11px] text-muted-foreground w-10 text-right">
                        {data.count}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          )}

          {/* Review filter / sort row */}
          {reviews.length > 0 && (
            <View className="flex-row items-center gap-2 mb-3 flex-wrap">
              <ReviewFilterPill
                label="All"
                active={reviewFilter == null}
                onPress={() => setReviewFilter(null)}
              />
              {[5, 4, 3, 2, 1].map((n) => (
                <ReviewFilterPill
                  key={n}
                  label={`${n}★`}
                  active={reviewFilter === n}
                  onPress={() => setReviewFilter(n)}
                />
              ))}
              <View className="ml-auto">
                <ReviewSortPill value={reviewSort} onChange={setReviewSort} />
              </View>
            </View>
          )}

          {filteredReviews.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {reviews.length === 0
                ? 'No reviews yet. Be the first!'
                : 'No reviews match the current filter.'}
            </Text>
          ) : (
            <View className="gap-3">
              {filteredReviews.map((review) => (
                <View
                  key={review.id}
                  className="p-4 rounded-2xl border border-border bg-card"
                >
                  <View className="flex-row items-center justify-between mb-2">
                    <StarRating rating={review.rating} size={13} />
                    <Text className="text-[10px] text-muted-foreground">
                      {timeAgo(review.createdAt)}
                    </Text>
                  </View>
                  {review.title && (
                    <Text className="text-sm font-semibold text-foreground mb-1">
                      {review.title}
                    </Text>
                  )}
                  {review.body && (
                    <Text className="text-sm text-foreground/80 leading-5">
                      {review.body}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>

        {/* More from creator */}
        {moreFromCreator.length > 0 && (
          <View className="mb-8">
            <SectionHeader
              title={`More from ${listing.creator.displayName}`}
              onSeeAll={() =>
                router.push(`/(app)/marketplace/creators/${listing.creator.id}` as any)
              }
            />
            <HorizontalRail
              items={moreFromCreator}
              keyExtractor={(item) => item.slug}
              itemWidth={220}
              renderItem={(item) => (
                <AgentTile
                  size="medium"
                  listing={toTileListing(item)}
                  onPress={() => router.push(`/(app)/marketplace/${item.slug}` as any)}
                />
              )}
            />
          </View>
        )}

        {/* Similar */}
        {similar.length > 0 && (
          <View className="mb-8">
            <SectionHeader
              title="You might also like"
              subtitle={
                listing.category ? `Other ${categoryLabel(listing.category)} agents` : undefined
              }
              onSeeAll={
                listing.category
                  ? () =>
                      router.push(
                        `/(app)/marketplace/category/${listing.category}` as any,
                      )
                  : undefined
              }
            />
            <HorizontalRail
              items={similar}
              keyExtractor={(item) => item.slug}
              itemWidth={220}
              renderItem={(item) => (
                <AgentTile
                  size="medium"
                  listing={toTileListing(item)}
                  onPress={() => router.push(`/(app)/marketplace/${item.slug}` as any)}
                />
              )}
            />
          </View>
        )}

        {/* Version footer */}
        <View className="px-5 mb-12">
          <View className="rounded-2xl border border-border bg-card px-4 py-3 flex-row items-center justify-between">
            <View>
              <Text className="text-xs font-semibold text-foreground">
                Version {listing.currentVersion}
              </Text>
              {listing.updatedAt && (
                <Text className="text-[11px] text-muted-foreground mt-0.5">
                  Updated {timeAgo(listing.updatedAt)}
                </Text>
              )}
            </View>
            {listing.publishedAt && (
              <Text className="text-[11px] text-muted-foreground">
                Published {timeAgo(listing.publishedAt)}
              </Text>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Sticky bottom CTA — only when hero scrolled out of view */}
      {!heroVisible && (
        <View
          className="absolute bottom-0 left-0 right-0 bg-background border-t border-border px-5 py-3 pb-6"
          style={{
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: -4 },
            elevation: 8,
          }}
        >
          <Pressable
            onPress={handleInstall}
            disabled={installing}
            accessibilityRole="button"
            accessibilityLabel={ctaLabel}
            className={`rounded-xl py-3.5 items-center justify-center ${
              installing ? 'bg-primary/60' : 'bg-primary active:bg-primary/80'
            }`}
          >
            {installing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <View className="flex-row items-center gap-2">
                {isPaid && <ExternalLink size={16} color="#fff" />}
                <Text className="text-primary-foreground font-semibold text-base">
                  {ctaLabel}
                </Text>
              </View>
            )}
          </Pressable>
        </View>
      )}

      {/* Lightbox */}
      <Modal
        visible={lightboxIndex != null}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxIndex(null)}
      >
        <View className="flex-1 bg-black/95 items-center justify-center">
          <Pressable
            onPress={() => setLightboxIndex(null)}
            className="absolute top-12 right-5 w-10 h-10 rounded-full bg-white/10 items-center justify-center z-10"
          >
            <X size={20} color="#fff" />
          </Pressable>
          {lightboxIndex != null && listing.screenshotUrls[lightboxIndex] && (
            <Image
              source={{ uri: listing.screenshotUrls[lightboxIndex] }}
              style={{ width: '95%', height: '85%' }}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>
    </View>
  )
})

// ── Sub-components ─────────────────────────────────────────────────

function CreatorStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
      <Text className="text-[10px] text-muted-foreground mt-0.5 uppercase" style={{ letterSpacing: 0.4 }}>
        {label}
      </Text>
    </View>
  )
}

function ReviewFilterPill({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full h-7 px-3 items-center justify-center border ${
        active ? 'bg-primary border-primary' : 'bg-card border-border'
      }`}
    >
      <Text
        className={`text-[11px] font-medium ${
          active ? 'text-primary-foreground' : 'text-foreground'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function ReviewSortPill({
  value,
  onChange,
}: {
  value: ReviewSort
  onChange: (v: ReviewSort) => void
}) {
  const labels: Record<ReviewSort, string> = {
    newest: 'Newest',
    highest: 'Highest',
    lowest: 'Lowest',
  }
  const order: ReviewSort[] = ['newest', 'highest', 'lowest']
  const next = order[(order.indexOf(value) + 1) % order.length]
  return (
    <Pressable
      onPress={() => onChange(next)}
      className="flex-row items-center gap-1 rounded-full h-7 px-3 border border-border bg-card"
    >
      <Text className="text-[11px] font-medium text-foreground">{labels[value]}</Text>
      <ChevronDown size={11} color="#71717a" />
    </Pressable>
  )
}

function DetailSkeleton() {
  return (
    <View className="flex-1 px-5 pt-4 gap-4">
      <View className="h-8 w-1/2 rounded bg-muted/40" />
      <View className="h-44 rounded-3xl bg-muted/40" />
      <View className="flex-row gap-3">
        <View className="h-44 flex-1 rounded-2xl bg-muted/40" />
        <View className="h-44 flex-1 rounded-2xl bg-muted/40" />
      </View>
      <View className="h-24 rounded-2xl bg-muted/40" />
    </View>
  )
}
