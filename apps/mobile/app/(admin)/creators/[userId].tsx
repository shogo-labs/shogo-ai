// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Creator Profile - Full per-creator 360: marketplace stats, published
 * listings, lifetime platform spend, and (when enrolled) affiliate/commission
 * info. Gated by the `creators:read` admin scope (super admins always allowed).
 * Backed by GET /api/admin/creators/:userId.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ArrowLeft,
  Star,
  Download,
  DollarSign,
  Users,
  Award,
  Package,
  Network,
  Calendar,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL, type AdminCreatorDetail } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return '—'
  }
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent = 'bg-primary/10',
  iconColor = 'text-primary',
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ size?: number; className?: string }>
  accent?: string
  iconColor?: string
}) {
  return (
    <View className="flex-1 min-w-[150px] rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</Text>
        <View className={cn('h-8 w-8 rounded-lg items-center justify-center', accent)}>
          <Icon size={16} className={iconColor} />
        </View>
      </View>
      <Text className="text-2xl font-bold text-foreground tracking-tight">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </Text>
    </View>
  )
}

const LISTING_COLS = [
  { key: 'title', label: 'Agent', width: 240, align: 'left' as const },
  { key: 'status', label: 'Status', width: 110, align: 'left' as const },
  { key: 'pricing', label: 'Pricing', width: 110, align: 'left' as const },
  { key: 'installs', label: 'Installs', width: 90, align: 'right' as const },
  { key: 'rating', label: 'Rating', width: 80, align: 'right' as const },
  { key: 'version', label: 'Version', width: 90, align: 'right' as const },
  { key: 'published', label: 'Published', width: 120, align: 'right' as const },
]

function ListingTable({ listings }: { listings: AdminCreatorDetail['listings'] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View className="flex-row border-b border-border bg-muted/30">
          {LISTING_COLS.map((col) => (
            <View key={col.key} style={{ width: col.width }} className="px-3 py-2.5">
              <Text
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
                  col.align === 'right' && 'text-right',
                )}
              >
                {col.label}
              </Text>
            </View>
          ))}
        </View>
        {listings.map((l) => (
          <View key={l.id} className="flex-row border-b border-border/50 items-center">
            <View style={{ width: LISTING_COLS[0].width }} className="px-3 py-3">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{l.title}</Text>
              <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{l.slug}</Text>
            </View>
            <View style={{ width: LISTING_COLS[1].width }} className="px-3 py-3">
              <Text className="text-xs text-foreground capitalize">{l.status}</Text>
            </View>
            <View style={{ width: LISTING_COLS[2].width }} className="px-3 py-3">
              <Text className="text-xs text-foreground capitalize">{l.pricingModel}</Text>
            </View>
            <View style={{ width: LISTING_COLS[3].width }} className="px-3 py-3">
              <Text className="text-sm text-foreground text-right">{l.installCount.toLocaleString()}</Text>
            </View>
            <View style={{ width: LISTING_COLS[4].width }} className="px-3 py-3">
              <Text className="text-sm text-foreground text-right">
                {l.averageRating > 0 ? l.averageRating.toFixed(1) : '—'}
              </Text>
            </View>
            <View style={{ width: LISTING_COLS[5].width }} className="px-3 py-3">
              <Text className="text-sm text-foreground text-right">{l.currentVersion}</Text>
            </View>
            <View style={{ width: LISTING_COLS[6].width }} className="px-3 py-3">
              <Text className="text-xs text-muted-foreground text-right">{fmtDate(l.publishedAt)}</Text>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function AffiliateCard({ a }: { a: NonNullable<AdminCreatorDetail['affiliate']> }) {
  const rate = a.commissionRateBps != null ? `${(a.commissionRateBps / 100).toFixed(2)}%` : 'Tier default'
  const cpm = a.contentCpmCents != null ? `$${(a.contentCpmCents / 100).toFixed(2)} / 1k views` : 'Platform default'
  const rows: { label: string; value: string }[] = [
    { label: 'Referral code', value: a.code },
    { label: 'Status', value: a.status },
    { label: 'L1 commission rate', value: rate },
    { label: 'Content CPM', value: cpm },
    { label: 'Referred users', value: a.referralCount.toLocaleString() },
    { label: 'Downline affiliates', value: a.downlineCount.toLocaleString() },
    { label: 'Referral earnings', value: usd(a.referralEarningsUsd) },
    { label: 'Content earnings', value: usd(a.contentEarningsUsd) },
    { label: 'Lifetime earnings', value: usd(a.totalEarningsUsd) },
    { label: 'Pending payout', value: usd(a.pendingPayoutUsd) },
    { label: 'Total paid out', value: usd(a.totalPaidOutUsd) },
  ]
  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-2 mb-3">
        <Network size={16} className="text-primary" />
        <Text className="text-sm font-semibold text-foreground">Affiliate &amp; commissions</Text>
      </View>
      <View className="flex-row flex-wrap">
        {rows.map((r) => (
          <View key={r.label} className="w-1/2 py-1.5 pr-3">
            <Text className="text-[11px] text-muted-foreground uppercase tracking-wide">{r.label}</Text>
            <Text className="text-sm text-foreground mt-0.5 capitalize">{r.value}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

export default function AdminCreatorProfile() {
  const router = useRouter()
  const { userId } = useLocalSearchParams<{ userId: string }>()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [creator, setCreator] = useState<AdminCreatorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!userId) return
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/creators/${encodeURIComponent(userId)}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        if (res.status === 403) setError('You do not have access to creator stats.')
        else if (res.status === 404) setError('Creator not found.')
        else setError('Failed to load creator profile.')
        setCreator(null)
        return
      }
      const json = await res.json()
      setCreator(json.data ?? null)
    } catch {
      setError('Failed to load creator profile.')
      setCreator(null)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { load() }, [load])

  const onRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: isWide ? 32 : 16, paddingBottom: 48, maxWidth: 1100, width: '100%', alignSelf: 'center' }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Back */}
      <Pressable
        onPress={() => router.back()}
        role="button"
        accessibilityLabel="Back to creators"
        className="flex-row items-center gap-1.5 mb-4 self-start active:opacity-70"
      >
        <ArrowLeft size={16} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Creators</Text>
      </Pressable>

      {loading ? (
        <View className="gap-3">
          <View className="h-16 bg-muted/50 rounded-xl" />
          <View className="flex-row gap-3">
            {[1, 2, 3, 4].map((i) => <View key={i} className="flex-1 h-24 bg-muted/50 rounded-xl" />)}
          </View>
          <View className="h-40 bg-muted/50 rounded-xl" />
        </View>
      ) : error ? (
        <View className="rounded-xl border border-border bg-card h-40 items-center justify-center px-4">
          <Text className="text-sm text-muted-foreground text-center">{error}</Text>
        </View>
      ) : creator ? (
        <View className="gap-6">
          {/* Header */}
          <View className="flex-row items-center gap-3">
            <View className="h-12 w-12 rounded-full bg-primary/10 items-center justify-center">
              <Text className="text-lg font-bold text-primary">
                {(creator.displayName || creator.name || '?').charAt(0).toUpperCase()}
              </Text>
            </View>
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-1.5">
                <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')} numberOfLines={1}>
                  {creator.displayName || creator.name || 'Unknown creator'}
                </Text>
                {creator.verified && <Star size={16} className="text-amber-500" />}
              </View>
              <Text className="text-sm text-muted-foreground" numberOfLines={1}>{creator.email}</Text>
              <View className="flex-row items-center gap-3 mt-1">
                <Text className="text-xs text-foreground capitalize">{creator.creatorTier} tier</Text>
                <View className="flex-row items-center gap-1">
                  <Calendar size={11} className="text-muted-foreground" />
                  <Text className="text-[11px] text-muted-foreground">Joined {fmtDate(creator.createdAt)}</Text>
                </View>
              </View>
            </View>
          </View>

          {creator.bio ? (
            <Text className="text-sm text-muted-foreground -mt-2">{creator.bio}</Text>
          ) : null}

          {/* Stat cards */}
          <View className="flex-row flex-wrap gap-3">
            <StatCard label="Installs" value={creator.totalInstalls} icon={Download} accent="bg-emerald-500/10" iconColor="text-emerald-500" />
            <StatCard label="Avg rating" value={creator.averageAgentRating > 0 ? creator.averageAgentRating.toFixed(1) : '—'} icon={Star} accent="bg-amber-500/10" iconColor="text-amber-500" />
            <StatCard label="Agents published" value={creator.totalAgentsPublished} icon={Package} accent="bg-blue-500/10" iconColor="text-blue-500" />
            <StatCard label="Followers" value={creator.followerCount} icon={Users} accent="bg-pink-500/10" iconColor="text-pink-500" />
            <StatCard label="Reputation" value={creator.reputationScore} icon={Award} accent="bg-indigo-500/10" iconColor="text-indigo-500" />
            <StatCard label="Lifetime earnings" value={usd(creator.totalEarningsUsd)} icon={DollarSign} accent="bg-amber-500/10" iconColor="text-amber-500" />
            <StatCard label="Pending payout" value={usd(creator.pendingPayoutUsd)} icon={DollarSign} accent="bg-yellow-500/10" iconColor="text-yellow-500" />
            <StatCard label="Platform spend" value={usd(creator.spendUsd)} icon={DollarSign} accent="bg-purple-500/10" iconColor="text-purple-500" />
          </View>

          {/* Published agents */}
          <View>
            <Text className="text-sm font-semibold text-foreground mb-2">
              Published agents ({creator.listings.length})
            </Text>
            <View className="rounded-xl border border-border bg-card overflow-hidden">
              {creator.listings.length === 0 ? (
                <View className="h-24 items-center justify-center">
                  <Text className="text-sm text-muted-foreground">No published listings</Text>
                </View>
              ) : (
                <ListingTable listings={creator.listings} />
              )}
            </View>
          </View>

          {/* Affiliate / commissions */}
          {creator.affiliate ? (
            <AffiliateCard a={creator.affiliate} />
          ) : (
            <View className="rounded-xl border border-dashed border-border bg-card/50 p-4">
              <View className="flex-row items-center gap-2">
                <Network size={15} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Not enrolled in the affiliate program.</Text>
              </View>
            </View>
          )}
        </View>
      ) : null}
    </ScrollView>
  )
}
