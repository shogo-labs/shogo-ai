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
  TextInput,
  ActivityIndicator,
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
  CheckCircle2,
  XCircle,
  Clock,
  Wallet,
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

const CONTENT_STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  none: { label: 'Not applied', cls: 'text-muted-foreground' },
  pending: { label: 'Pending review', cls: 'text-amber-600' },
  approved: { label: 'Approved', cls: 'text-emerald-600' },
  rejected: { label: 'Rejected', cls: 'text-red-600' },
}

function AffiliateCard({
  a,
  onChanged,
}: {
  a: NonNullable<AdminCreatorDetail['affiliate']>
  onChanged: () => void | Promise<void>
}) {
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
    { label: 'Total paid out', value: usd(a.totalPaidOutUsd) },
  ]

  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'payout'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [showReject, setShowReject] = useState(false)
  const [reason, setReason] = useState('')
  const [showApprove, setShowApprove] = useState(false)
  // Dollars-per-1k-views as typed by the admin; blank => platform default.
  const [cpmInput, setCpmInput] = useState(
    a.contentCpmCents != null ? (a.contentCpmCents / 100).toFixed(2) : '',
  )

  const status = a.contentProgramStatus ?? 'none'
  const statusStyle = CONTENT_STATUS_STYLE[status] ?? CONTENT_STATUS_STYLE.none
  const payoutReady = a.payoutStatus === 'verified'

  const review = useCallback(
    async (action: 'approve' | 'reject') => {
      // On approve, translate the dollars input into integer cents per 1,000
      // views. Blank => null (platform default). Reject ignores CPM.
      let contentCpmCents: number | null | undefined
      if (action === 'approve') {
        const trimmed = cpmInput.trim()
        if (trimmed === '') {
          contentCpmCents = null
        } else {
          const dollars = Number(trimmed)
          if (!Number.isFinite(dollars) || dollars < 0) {
            setActionError('Enter a valid CPM (e.g. 1.50) or leave blank for platform default.')
            return
          }
          contentCpmCents = Math.round(dollars * 100)
        }
      }

      setBusy(action)
      setActionError(null)
      setActionMsg(null)
      try {
        const res = await fetch(`${API_BASE}/affiliates/${encodeURIComponent(a.id)}/content-application`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            reason: action === 'reject' ? reason.trim() || undefined : undefined,
            ...(action === 'approve' ? { contentCpmCents } : {}),
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setActionError(body?.error?.message ?? 'Action failed.')
          return
        }
        setShowReject(false)
        setShowApprove(false)
        setReason('')
        await onChanged()
      } catch {
        setActionError('Action failed. Please try again.')
      } finally {
        setBusy(null)
      }
    },
    [a.id, reason, cpmInput, onChanged],
  )

  const payout = useCallback(async () => {
    setBusy('payout')
    setActionError(null)
    setActionMsg(null)
    try {
      const res = await fetch(`${API_BASE}/affiliates/${encodeURIComponent(a.id)}/payout`, {
        method: 'POST',
        credentials: 'include',
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setActionError(body?.error?.message ?? 'Payout failed.')
        return
      }
      setActionMsg(`Paid ${usd((body?.paidCents ?? 0) / 100)}.`)
      await onChanged()
    } catch {
      setActionError('Payout failed. Please try again.')
    } finally {
      setBusy(null)
    }
  }, [a.id, onChanged])

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

      {/* Video-creator (content CPM) program review */}
      <View className="border-t border-border mt-3 pt-3 gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-[11px] text-muted-foreground uppercase tracking-wide">Video-creator program</Text>
          <Text className={cn('text-xs font-semibold', statusStyle.cls)}>{statusStyle.label}</Text>
        </View>
        {status === 'rejected' && a.contentRejectionReason ? (
          <Text className="text-[11px] text-red-600">Reason: {a.contentRejectionReason}</Text>
        ) : null}
        {a.contentAppliedAt ? (
          <Text className="text-[11px] text-muted-foreground">Applied {fmtDate(a.contentAppliedAt)}</Text>
        ) : null}

        {status === 'pending' || status === 'rejected' || status === 'approved' ? (
          <View className="gap-2">
            {showReject ? (
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="Reason for rejection (optional)"
                placeholderTextColor="#9ca3af"
                className="rounded-md border border-border px-3 py-2 text-sm text-foreground"
              />
            ) : null}
            {showApprove ? (
              <View className="gap-1">
                <Text className="text-[11px] text-muted-foreground">
                  Content CPM ($ per 1,000 views) — leave blank for platform default
                </Text>
                <View className="flex-row items-center gap-2 rounded-md border border-border px-3">
                  <Text className="text-sm text-muted-foreground">$</Text>
                  <TextInput
                    value={cpmInput}
                    onChangeText={setCpmInput}
                    placeholder="1.00"
                    placeholderTextColor="#9ca3af"
                    keyboardType="decimal-pad"
                    className="flex-1 py-2 text-sm text-foreground"
                  />
                  <Text className="text-[11px] text-muted-foreground">/ 1k</Text>
                </View>
              </View>
            ) : null}
            <View className="flex-row gap-2">
              {status !== 'approved' ? (
                <Pressable
                  onPress={() => (showApprove ? review('approve') : (setShowApprove(true), setShowReject(false)))}
                  disabled={busy !== null}
                  className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 active:opacity-80"
                >
                  {busy === 'approve' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <CheckCircle2 size={14} color="#fff" />
                  )}
                  <Text className="text-xs font-semibold text-white">
                    {showApprove ? 'Confirm approve' : 'Approve'}
                  </Text>
                </Pressable>
              ) : null}
              {status !== 'rejected' ? (
                <Pressable
                  onPress={() => (showReject ? review('reject') : (setShowReject(true), setShowApprove(false)))}
                  disabled={busy !== null}
                  className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg border border-red-500/40 active:opacity-80"
                >
                  {busy === 'reject' ? (
                    <ActivityIndicator size="small" color="#dc2626" />
                  ) : (
                    <XCircle size={14} color="#dc2626" />
                  )}
                  <Text className="text-xs font-semibold text-red-600">
                    {showReject ? 'Confirm reject' : 'Reject'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>

      {/* Manual payout — owed (approved + unpaid) balance */}
      <View className="border-t border-border mt-3 pt-3 gap-2">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-[11px] text-muted-foreground uppercase tracking-wide">Owed (payable now)</Text>
            <Text className="text-lg font-bold text-foreground">{usd(a.payableUsd)}</Text>
          </View>
          <Pressable
            onPress={payout}
            disabled={busy !== null || a.payableUsd <= 0 || !payoutReady}
            className={cn(
              'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
              a.payableUsd > 0 && payoutReady ? 'bg-primary active:opacity-80' : 'bg-muted',
            )}
          >
            {busy === 'payout' ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Wallet size={14} className={a.payableUsd > 0 && payoutReady ? 'text-primary-foreground' : 'text-muted-foreground'} />
            )}
            <Text
              className={cn(
                'text-xs font-semibold',
                a.payableUsd > 0 && payoutReady ? 'text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              Approve &amp; pay
            </Text>
          </Pressable>
        </View>
        {!payoutReady ? (
          <View className="flex-row items-center gap-1.5">
            <Clock size={12} className="text-amber-500" />
            <Text className="text-[11px] text-muted-foreground">
              Payout setup not verified ({a.payoutStatus}). Creator must finish Stripe onboarding first.
            </Text>
          </View>
        ) : null}
        {actionError ? <Text className="text-[11px] text-red-600">{actionError}</Text> : null}
        {actionMsg ? <Text className="text-[11px] text-emerald-600">{actionMsg}</Text> : null}
        <Text className="text-[10px] text-muted-foreground">
          Payouts are never automatic — releasing pays the creator's approved, unpaid commissions via Stripe.
        </Text>
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
            <AffiliateCard a={creator.affiliate} onChanged={load} />
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
