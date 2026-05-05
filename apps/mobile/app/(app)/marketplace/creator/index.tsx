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
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  DollarSign,
  Download,
  Star,
  Clock,
  Plus,
  Award,
  ChevronRight,
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  Users,
  CreditCard,
  RefreshCcw,
  CheckCircle2,
  Circle,
} from 'lucide-react-native'
import { useAuth } from '../../../../contexts/auth'
import { useDomainHttp } from '../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'
import { Sparkline, TIER_BG, TIER_LABEL, type CreatorTier } from '../../../../components/marketplace'

interface CreatorProfile {
  id: string
  userId: string
  displayName: string
  avatarUrl?: string | null
  bio?: string | null
  creatorTier: CreatorTier
  reputationScore: number
  payoutStatus: string
  totalEarningsInCents: number
  pendingPayoutInCents: number
  totalInstalls: number
  averageAgentRating: number
  createdAt: string
}

interface DashboardListing {
  id: string
  slug: string
  title: string
  status: string
  installCount: number
  averageRating: number
  reviewCount: number
  totalEarningsInCents: number
}

interface DashboardAPIResponse {
  profile: CreatorProfile
  totalReviews: number
  listings: DashboardListing[]
}

interface Transaction {
  id: string
  listingId: string
  type: string
  amountInCents: number
  creatorAmountInCents: number
  status: string
  currency: string
  createdAt: string
}

interface TransactionsResponse {
  items: Transaction[]
  total: number
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function payoutColor(status: string): string {
  if (status === 'verified') return 'bg-green-500'
  if (status === 'pending') return 'bg-yellow-500'
  return 'bg-gray-400'
}

function payoutLabel(status: string): string {
  if (status === 'verified') return 'Verified'
  if (status === 'pending') return 'Pending verification'
  return 'Not set up'
}

/**
 * Bucket transactions into 30 daily totals (oldest → newest). Returns an
 * array of length 30. Used to drive the earnings sparkline.
 */
function buildDailySeries(
  transactions: Transaction[],
  days = 30,
): { series: number[]; lastWindow: number; prevWindow: number } {
  const now = new Date()
  const series: number[] = Array(days).fill(0)
  const startMs = now.getTime() - days * 24 * 60 * 60 * 1000
  let lastWindow = 0
  let prevWindow = 0

  for (const t of transactions) {
    const tMs = new Date(t.createdAt).getTime()
    if (t.status !== 'completed') continue
    const dayDiff = Math.floor((now.getTime() - tMs) / (24 * 60 * 60 * 1000))
    if (dayDiff < 0) continue
    if (dayDiff < days) {
      // newest goes to last index
      series[days - 1 - dayDiff] += t.creatorAmountInCents / 100
      lastWindow += t.creatorAmountInCents
    } else if (dayDiff < days * 2) {
      prevWindow += t.creatorAmountInCents
    }
  }

  return { series, lastWindow, prevWindow }
}

export default observer(function CreatorDashboardScreen() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()

  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [dashboardListings, setDashboardListings] = useState<DashboardListing[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalReviews, setTotalReviews] = useState(0)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasProfile, setHasProfile] = useState<boolean | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const profileRes = await http.get<{ profile: CreatorProfile }>(
        '/api/marketplace/creator/profile',
      )
      const prof = profileRes.data.profile
      setProfile(prof)
      setHasProfile(true)

      const [dashboardRes, transactionsRes] = await Promise.all([
        http.get<DashboardAPIResponse>('/api/marketplace/creator/dashboard'),
        http.get<TransactionsResponse>('/api/marketplace/creator/transactions?limit=100'),
      ])
      setDashboardListings(dashboardRes.data.listings ?? [])
      setTotalReviews(dashboardRes.data.totalReviews ?? 0)
      setTransactions(transactionsRes.data.items ?? [])
    } catch (err: any) {
      if (err?.status === 404 || err?.message?.includes('not found')) {
        setHasProfile(false)
      } else {
        setError('Failed to load creator dashboard')
      }
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleBecomeCreator = useCallback(async () => {
    if (!user?.name) return
    setCreating(true)
    setError(null)
    try {
      await http.post<{ profile: CreatorProfile }>(
        '/api/marketplace/creator/profile',
        { displayName: user.name },
      )
      await loadData()
    } catch {
      setError('Failed to create creator profile')
    } finally {
      setCreating(false)
    }
  }, [http, user?.name, loadData])

  const earningsSeries = useMemo(
    () => buildDailySeries(transactions, 30),
    [transactions],
  )

  const earningsDelta = useMemo(() => {
    const { lastWindow, prevWindow } = earningsSeries
    if (prevWindow === 0) return lastWindow > 0 ? 100 : 0
    return Math.round(((lastWindow - prevWindow) / prevWindow) * 100)
  }, [earningsSeries])

  const recentTransactions = useMemo(() => transactions.slice(0, 5), [transactions])

  // Onboarding step state
  const stepProfile = !!profile
  const stepPayout = profile?.payoutStatus === 'verified'
  const stepListing = dashboardListings.some((l) => l.status === 'published')
  const completedSteps = [stepProfile, stepPayout, stepListing].filter(Boolean).length
  const onboardingComplete = completedSteps === 3

  // ─── Empty state ────────────────────────────────────────────────
  if (hasProfile === false) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
          <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
            <ArrowLeft size={20} color="#71717a" />
          </Pressable>
          <Text className="text-base font-semibold text-foreground flex-1">
            Creator Program
          </Text>
        </View>
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 24, paddingTop: 16 }}>
          <View className="items-center mt-2 mb-10">
            <View className="w-16 h-16 rounded-full bg-primary/15 items-center justify-center mb-4">
              <Award size={28} color="#e27927" />
            </View>
            <Text className="text-2xl font-bold text-foreground mb-2 text-center">
              Become a Creator
            </Text>
            <Text className="text-sm text-muted-foreground text-center max-w-md leading-5">
              Share your agents with the Shogo community and earn from every install.
              Set up your creator profile to get started.
            </Text>
          </View>

          {/* Value-prop cards */}
          <View className="gap-3 mb-8">
            <ValueProp
              icon={Users}
              title="Reach the Shogo community"
              body="Get your agent in front of every workspace browsing the marketplace, with editorial features for the best work."
            />
            <ValueProp
              icon={DollarSign}
              title="Earn from every install"
              body="Set free, one-time, or subscription pricing. Payouts go straight to your bank via Stripe Connect."
            />
            <ValueProp
              icon={Award}
              title="Keep ownership of your work"
              body="Buyers fork or link to your project. You decide whether they receive your future updates."
            />
          </View>

          {error && (
            <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-destructive/10">
              <AlertCircle size={16} color="#dc2626" />
              <Text className="text-sm text-destructive flex-1">{error}</Text>
            </View>
          )}

          <Pressable
            onPress={handleBecomeCreator}
            disabled={creating}
            className={cn(
              'py-3.5 rounded-xl items-center justify-center',
              creating ? 'bg-primary/60' : 'bg-primary active:opacity-90',
            )}
          >
            {creating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text className="text-sm font-semibold text-primary-foreground">
                Get started
              </Text>
            )}
          </Pressable>
          <Text className="text-[11px] text-muted-foreground text-center mt-3">
            Free to join. You can publish your first listing in minutes.
          </Text>
        </ScrollView>
      </View>
    )
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-6">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-xl font-bold text-foreground">Creator dashboard</Text>
        </View>
        {profile?.id && (
          <Pressable
            onPress={() => router.push(`/(app)/marketplace/creators/${profile.id}` as any)}
            className="flex-row items-center gap-1 px-3 py-1.5 rounded-lg border border-border active:opacity-70"
          >
            <Text className="text-xs font-medium text-foreground">View public</Text>
            <ChevronRight size={12} color="#71717a" />
          </Pressable>
        )}
      </View>

      {error && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-destructive/10">
          <AlertCircle size={16} color="#dc2626" />
          <Text className="text-sm text-destructive">{error}</Text>
        </View>
      )}

      {/* Tier card */}
      {profile && (
        <View className="rounded-2xl border border-border bg-card p-4 mb-5 flex-row items-center gap-3">
          {profile.avatarUrl ? (
            <Image
              source={{ uri: profile.avatarUrl }}
              style={{ width: 44, height: 44, borderRadius: 999 }}
            />
          ) : (
            <View
              className={`${TIER_BG[profile.creatorTier]} rounded-full items-center justify-center`}
              style={{ width: 44, height: 44 }}
            >
              <Text className="text-white font-bold text-lg">
                {profile.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <View className="flex-1 min-w-0">
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {profile.displayName}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {TIER_LABEL[profile.creatorTier]} · {profile.reputationScore} reputation
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <View className={cn('w-2 h-2 rounded-full', payoutColor(profile.payoutStatus))} />
            <Text className="text-xs text-muted-foreground">
              {payoutLabel(profile.payoutStatus)}
            </Text>
          </View>
        </View>
      )}

      {/* Onboarding checklist */}
      {!onboardingComplete && (
        <View className="rounded-2xl border border-primary/30 bg-primary/5 p-4 mb-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-sm font-semibold text-foreground">
              Get your profile production-ready
            </Text>
            <Text className="text-xs text-muted-foreground">
              {completedSteps} of 3
            </Text>
          </View>
          <ChecklistItem
            done={stepProfile}
            label="Create your creator profile"
            onPress={undefined}
          />
          <ChecklistItem
            done={stepPayout}
            label="Set up payouts to receive earnings"
            onPress={
              !stepPayout
                ? () => router.push('/(app)/marketplace/creator/payout-setup' as any)
                : undefined
            }
          />
          <ChecklistItem
            done={stepListing}
            label="Publish your first listing"
            onPress={
              !stepListing
                ? () =>
                    router.push({
                      pathname: '/(app)/marketplace/creator/listing/[id]',
                      params: { id: 'new' },
                    })
                : undefined
            }
            isLast
          />
        </View>
      )}

      {/* Earnings hero card with sparkline */}
      {profile && (
        <View className="rounded-2xl border border-border bg-card p-5 mb-3">
          <View className="flex-row items-start justify-between mb-3">
            <View>
              <Text className="text-xs text-muted-foreground mb-1">Earnings (last 30 days)</Text>
              <Text className="text-3xl font-bold text-foreground">
                {formatCents(earningsSeries.lastWindow)}
              </Text>
              <View className="flex-row items-center gap-1 mt-1">
                {earningsDelta >= 0 ? (
                  <ArrowUpRight size={12} color="#22c55e" />
                ) : (
                  <ArrowDownRight size={12} color="#ef4444" />
                )}
                <Text
                  className={`text-xs font-semibold ${
                    earningsDelta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
                  }`}
                >
                  {earningsDelta >= 0 ? '+' : ''}
                  {earningsDelta}%
                </Text>
                <Text className="text-xs text-muted-foreground">vs previous 30 days</Text>
              </View>
            </View>
            <Sparkline data={earningsSeries.series} width={140} height={40} />
          </View>
          <View className="flex-row gap-3 mt-2 border-t border-border pt-3">
            <MiniStat
              label="Lifetime earnings"
              value={formatCents(profile.totalEarningsInCents)}
              icon={DollarSign}
              tint="text-emerald-500"
            />
            <MiniStat
              label="Pending payout"
              value={formatCents(profile.pendingPayoutInCents)}
              icon={Clock}
              tint="text-yellow-500"
            />
            <MiniStat
              label="Installs"
              value={profile.totalInstalls.toLocaleString()}
              icon={Download}
              tint="text-blue-500"
            />
            <MiniStat
              label="Avg rating"
              value={
                profile.averageAgentRating > 0
                  ? profile.averageAgentRating.toFixed(1)
                  : '—'
              }
              icon={Star}
              tint="text-amber-500"
            />
          </View>
        </View>
      )}

      {/* Recent transactions */}
      {recentTransactions.length > 0 && (
        <View className="rounded-2xl border border-border bg-card p-4 mb-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-sm font-semibold text-foreground">Recent transactions</Text>
            <Text className="text-xs text-muted-foreground">
              {totalReviews > 0 ? `${totalReviews} reviews` : ''}
            </Text>
          </View>
          <View className="gap-2.5">
            {recentTransactions.map((t) => (
              <TransactionRow key={t.id} transaction={t} />
            ))}
          </View>
        </View>
      )}

      {/* Listings */}
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-base font-bold text-foreground">My listings</Text>
        <Pressable
          onPress={() =>
            router.push({
              pathname: '/(app)/marketplace/creator/listing/[id]',
              params: { id: 'new' },
            })
          }
          className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary"
        >
          <Plus size={14} color="#fff" />
          <Text className="text-xs font-semibold text-primary-foreground">New listing</Text>
        </Pressable>
      </View>

      {dashboardListings.length > 0 ? (
        <View className="gap-3">
          {dashboardListings.map((listing) => (
            <ListingRow
              key={listing.id}
              listing={listing}
              onPress={() =>
                router.push({
                  pathname: '/(app)/marketplace/creator/listing/[id]',
                  params: { id: listing.id },
                })
              }
              onViewPublic={
                listing.status === 'published'
                  ? () =>
                      router.push(`/(app)/marketplace/${listing.slug}` as any)
                  : undefined
              }
              transactions={transactions.filter((t) => t.listingId === listing.id)}
            />
          ))}
        </View>
      ) : (
        <View className="items-center py-12 rounded-2xl border border-dashed border-border">
          <Plus size={32} color="#a1a1aa" />
          <Text className="text-sm font-medium text-foreground mt-3 mb-1">
            No listings yet
          </Text>
          <Text className="text-xs text-muted-foreground text-center max-w-xs">
            Publish your first agent to start earning from installs.
          </Text>
        </View>
      )}
    </ScrollView>
  )
})

// ── Sub-components ─────────────────────────────────────────────────

function ValueProp({
  icon: Icon,
  title,
  body,
}: {
  icon: any
  title: string
  body: string
}) {
  return (
    <View className="rounded-2xl border border-border bg-card p-4 flex-row gap-3">
      <View className="rounded-xl bg-primary/15 w-10 h-10 items-center justify-center mt-0.5">
        <Icon size={18} color="#e27927" />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground mb-1">{title}</Text>
        <Text className="text-xs text-muted-foreground leading-4">{body}</Text>
      </View>
    </View>
  )
}

function ChecklistItem({
  done,
  label,
  onPress,
  isLast,
}: {
  done: boolean
  label: string
  onPress?: () => void
  isLast?: boolean
}) {
  const inner = (
    <View
      className={cn(
        'flex-row items-center gap-3 py-2.5',
        !isLast && 'border-b border-primary/10',
      )}
    >
      {done ? (
        <CheckCircle2 size={18} color="#22c55e" />
      ) : (
        <Circle size={18} color="#a1a1aa" />
      )}
      <Text
        className={cn(
          'text-sm flex-1',
          done ? 'text-muted-foreground line-through' : 'text-foreground',
        )}
      >
        {label}
      </Text>
      {onPress && !done && <ChevronRight size={14} color="#71717a" />}
    </View>
  )
  if (onPress) {
    return (
      <Pressable onPress={onPress} className="active:opacity-70">
        {inner}
      </Pressable>
    )
  }
  return inner
}

function MiniStat({
  label,
  value,
  icon: Icon,
  tint,
}: {
  label: string
  value: string
  icon: any
  tint: string
}) {
  return (
    <View className="flex-1">
      <Icon size={13} className={tint} />
      <Text className="text-sm font-semibold text-foreground mt-1">{value}</Text>
      <Text className="text-[10px] text-muted-foreground">{label}</Text>
    </View>
  )
}

function ListingRow({
  listing,
  onPress,
  onViewPublic,
  transactions,
}: {
  listing: DashboardListing
  onPress: () => void
  onViewPublic?: () => void
  transactions: Transaction[]
}) {
  // Build a small per-listing earnings sparkline from transactions.
  const series = useMemo(() => {
    const days = 14
    const out: number[] = Array(days).fill(0)
    const now = Date.now()
    for (const t of transactions) {
      if (t.status !== 'completed') continue
      const d = Math.floor((now - new Date(t.createdAt).getTime()) / (24 * 60 * 60 * 1000))
      if (d >= 0 && d < days) out[days - 1 - d] += t.creatorAmountInCents / 100
    }
    return out
  }, [transactions])

  const statusStyle =
    listing.status === 'published'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : listing.status === 'draft'
        ? 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'
        : 'bg-red-500/15 text-red-600 dark:text-red-400'

  return (
    <Pressable
      onPress={onPress}
      className="rounded-2xl border border-border bg-card p-4 active:opacity-90"
    >
      <View className="flex-row items-start justify-between mb-2 gap-2">
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {listing.title}
          </Text>
          <Text className="text-[11px] text-muted-foreground mt-0.5">
            {formatCents(listing.totalEarningsInCents)} earned
          </Text>
        </View>
        <View className={cn('px-2 py-0.5 rounded-full', statusStyle.split(' ')[0])}>
          <Text
            className={cn(
              'text-[10px] font-semibold capitalize',
              statusStyle.split(' ').slice(1).join(' '),
            )}
          >
            {listing.status === 'archived' ? 'Unlisted' : listing.status}
          </Text>
        </View>
      </View>
      <View className="flex-row items-center gap-4">
        <View className="flex-row items-center gap-1">
          <Download size={12} color="#71717a" />
          <Text className="text-xs text-muted-foreground">
            {listing.installCount.toLocaleString()}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Star size={12} fill="#eab308" color="#eab308" />
          <Text className="text-xs text-muted-foreground">
            {listing.averageRating > 0 ? listing.averageRating.toFixed(1) : '—'}
            {listing.reviewCount > 0 ? ` (${listing.reviewCount})` : ''}
          </Text>
        </View>
        {onViewPublic && (
          <Pressable
            onPress={onViewPublic}
            hitSlop={6}
            className="ml-auto flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-xs font-medium text-primary">View public</Text>
            <ChevronRight size={11} color="#e27927" />
          </Pressable>
        )}
        <View className={onViewPublic ? '' : 'ml-auto'}>
          <Sparkline data={series} width={70} height={22} stroke="#22c55e" />
        </View>
      </View>
    </Pressable>
  )
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const isIncoming = transaction.type === 'purchase' || transaction.type === 'subscription'
  const Icon = isIncoming
    ? CreditCard
    : transaction.type === 'refund'
      ? RefreshCcw
      : TrendingUp
  return (
    <View className="flex-row items-center gap-3">
      <View className="rounded-full bg-muted w-8 h-8 items-center justify-center">
        <Icon size={14} color="#71717a" />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-xs font-medium text-foreground capitalize">
          {transaction.type.replace('_', ' ')}
        </Text>
        <Text className="text-[10px] text-muted-foreground">
          {new Date(transaction.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <View className="items-end">
        <Text
          className={`text-xs font-semibold ${
            transaction.status === 'completed'
              ? 'text-emerald-600 dark:text-emerald-400'
              : transaction.status === 'pending'
                ? 'text-yellow-600 dark:text-yellow-400'
                : 'text-muted-foreground'
          }`}
        >
          {formatCents(transaction.creatorAmountInCents)}
        </Text>
        <Text className="text-[10px] text-muted-foreground capitalize">
          {transaction.status}
        </Text>
      </View>
    </View>
  )
}
