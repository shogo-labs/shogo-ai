// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Marketplace Payouts.
 *
 * Two sub-tabs:
 *   - Pending: multi-select creators with non-zero
 *     `pendingPayoutInCents` and call POST /payouts/release. Per-row
 *     "Hold" sends POST /payouts/hold with a reason.
 *   - History: paginated MarketplaceTransaction rows from
 *     GET /payouts/history (optionally filtered by creatorId).
 *
 * Endpoints:
 *   GET /api/admin/marketplace/payouts/pending
 *   POST /api/admin/marketplace/payouts/release { creatorIds, amountInCents? }
 *   POST /api/admin/marketplace/payouts/hold    { creatorId, reason }
 *   GET /api/admin/marketplace/payouts/history?creatorId&page&limit
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  Alert,
  useWindowDimensions,
} from 'react-native'
import {
  DollarSign,
  Banknote,
  Pause,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  History,
  ArrowDownLeft,
  ArrowUpRight,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

import { fetchAdminJson, postAdmin, formatCents, formatRelative } from './_helpers'

type PayoutStatusValue =
  | 'not_setup'
  | 'pending_verification'
  | 'verified'
  | 'requires_update'
  | 'disabled'

interface PendingPayoutRow {
  creatorId: string
  displayName: string
  email: string
  pendingPayoutInCents: number
  stripeBalance: number | null
  payoutStatus: PayoutStatusValue
  stripeCustomAccountId: string | null
}

interface ReleaseResultRow {
  creatorId: string
  success: boolean
  payoutId?: string
  amountInCents?: number
  error?: string
}

interface HistoryRow {
  id: string
  createdAt: string
  type: string
  amountInCents: number
  platformFeeInCents: number
  creatorAmountInCents: number
  status: string
  stripeTransferId: string | null
  listing: { id: string; slug: string; title: string; status: string; pricingModel: string } | null
  creator: {
    id: string
    displayName: string
    user: { id: string; email: string; name: string | null }
  } | null
}

interface HistoryResponse {
  items: HistoryRow[]
  total: number
  page: number
  limit: number
  totalPages: number
}

const PAYOUT_STATUS_LABEL: Record<PayoutStatusValue, { bg: string; label: string }> = {
  not_setup: { bg: 'bg-muted', label: 'Not set up' },
  pending_verification: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: 'Verifying' },
  verified: { bg: 'bg-green-100 dark:bg-green-900/30', label: 'Verified' },
  requires_update: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: 'Needs update' },
  disabled: { bg: 'bg-red-100 dark:bg-red-900/30', label: 'Disabled' },
}

function PayoutStatusPill({ status }: { status: PayoutStatusValue }) {
  const pill = PAYOUT_STATUS_LABEL[status]
  return (
    <View className={cn('px-2 py-0.5 rounded-full', pill.bg)}>
      <Text className="text-[10px] font-medium text-foreground">{pill.label}</Text>
    </View>
  )
}

function HoldModal({
  visible,
  creator,
  busy,
  onCancel,
  onSubmit,
}: {
  visible: boolean
  creator: PendingPayoutRow | null
  busy: boolean
  onCancel: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (!visible) setReason('')
  }, [visible])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 items-center justify-center bg-black/50 px-6">
        <View className="bg-card rounded-2xl border border-border p-6 w-full max-w-md">
          <Text className="text-base font-semibold text-foreground mb-1">Hold payouts</Text>
          <Text className="text-sm text-muted-foreground mb-4">
            {creator ? `${creator.displayName} (${creator.email})` : ''}
          </Text>
          <Text className="text-xs font-medium text-foreground mb-1.5">Reason (audit trail)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. KYC re-verification needed"
            placeholderTextColor="#9ca3af"
            multiline
            numberOfLines={3}
            editable={!busy}
            className="border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background min-h-[72px]"
            style={{ textAlignVertical: 'top' }}
          />
          <View className="flex-row justify-end gap-2 mt-4">
            <Pressable
              onPress={onCancel}
              disabled={busy}
              className="px-4 py-2 rounded-lg active:bg-muted"
            >
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onSubmit(reason.trim())}
              disabled={busy || reason.trim().length === 0}
              className={cn(
                'px-4 py-2 rounded-lg flex-row items-center gap-1.5',
                busy || reason.trim().length === 0
                  ? 'bg-red-500/40'
                  : 'bg-red-600 active:opacity-80',
              )}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Pause size={14} color="#fff" />
              )}
              <Text className="text-sm font-semibold text-white">
                {busy ? 'Holding…' : 'Hold'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function PendingTab({ isWide }: { isWide: boolean }) {
  const [rows, setRows] = useState<PendingPayoutRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [releasing, setReleasing] = useState(false)
  const [results, setResults] = useState<ReleaseResultRow[] | null>(null)
  const [holdTarget, setHoldTarget] = useState<PendingPayoutRow | null>(null)
  const [holdBusy, setHoldBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await fetchAdminJson<PendingPayoutRow[]>('/payouts/pending')
    setRows(data ?? [])
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const toggle = (creatorId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(creatorId)) next.delete(creatorId)
      else next.add(creatorId)
      return next
    })
  }

  const allEligible = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          r.payoutStatus === 'verified' &&
          r.stripeBalance != null &&
          r.stripeBalance > 0 &&
          r.pendingPayoutInCents > 0,
      ),
    [rows],
  )

  const toggleAll = () => {
    if (selected.size === allEligible.length && allEligible.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(allEligible.map((r) => r.creatorId)))
    }
  }

  const onReleaseSelected = async () => {
    if (selected.size === 0) return
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        `Release ${selected.size} payout${selected.size === 1 ? '' : 's'}?`,
        'Each creator will be paid their full available Stripe balance.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Release', style: 'default', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      )
    })
    if (!proceed) return

    setReleasing(true)
    setResults(null)
    const res = await postAdmin<{ results: ReleaseResultRow[] }>('/payouts/release', {
      creatorIds: Array.from(selected),
    })
    setReleasing(false)
    if (!res.ok) {
      Alert.alert('Release failed', res.error ?? 'Unknown error')
      return
    }
    setResults(res.data?.results ?? [])
    setSelected(new Set())
    load()
  }

  const onSubmitHold = async (reason: string) => {
    if (!holdTarget || !reason) return
    setHoldBusy(true)
    const res = await postAdmin('/payouts/hold', {
      creatorId: holdTarget.creatorId,
      reason,
    })
    setHoldBusy(false)
    if (!res.ok) {
      Alert.alert('Hold failed', res.error ?? 'Unknown error')
      return
    }
    setHoldTarget(null)
    load()
  }

  const renderRow = ({ item }: { item: PendingPayoutRow }) => {
    const isSelected = selected.has(item.creatorId)
    const eligible =
      item.payoutStatus === 'verified' &&
      item.stripeBalance != null &&
      item.stripeBalance > 0 &&
      item.pendingPayoutInCents > 0
    const result = results?.find((r) => r.creatorId === item.creatorId)
    return (
      <View
        className={cn(
          'flex-row items-center border-b border-border',
          isWide ? 'px-4 py-3' : 'p-3',
        )}
      >
        <Pressable
          onPress={() => eligible && toggle(item.creatorId)}
          disabled={!eligible}
          className={cn(
            'h-5 w-5 rounded border mr-3 items-center justify-center',
            !eligible
              ? 'border-border bg-muted opacity-40'
              : isSelected
                ? 'border-primary bg-primary'
                : 'border-border bg-card',
          )}
        >
          {isSelected && <CheckCircle2 size={12} color="#fff" />}
        </Pressable>

        <View className={cn('min-w-0 mr-2', isWide ? 'w-[260px]' : 'flex-1')}>
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {item.displayName}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {item.email}
          </Text>
          {result && (
            <Text
              className={cn(
                'text-[11px] mt-0.5',
                result.success
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-red-700 dark:text-red-400',
              )}
              numberOfLines={2}
            >
              {result.success
                ? `Paid ${formatCents(result.amountInCents ?? 0)} · ${result.payoutId ?? ''}`
                : `Failed: ${result.error ?? 'unknown error'}`}
            </Text>
          )}
        </View>

        <View className="w-[110px] mr-3">
          <Text className="text-sm font-semibold text-foreground text-right">
            {formatCents(item.pendingPayoutInCents)}
          </Text>
          <Text className="text-[10px] text-muted-foreground text-right">pending</Text>
        </View>

        {isWide && (
          <View className="w-[110px] mr-3">
            <Text className="text-sm text-foreground text-right">
              {item.stripeBalance != null ? formatCents(item.stripeBalance) : '—'}
            </Text>
            <Text className="text-[10px] text-muted-foreground text-right">stripe</Text>
          </View>
        )}

        <View className="mr-3">
          <PayoutStatusPill status={item.payoutStatus} />
        </View>

        <Pressable
          onPress={() => setHoldTarget(item)}
          className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border active:bg-muted"
        >
          <Pause size={11} className="text-foreground" />
          <Text className="text-xs font-medium text-foreground">Hold</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <>
      <View className={cn('flex-row items-center justify-between mb-3 gap-3 flex-wrap')}>
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={toggleAll}
            disabled={allEligible.length === 0}
            className={cn(
              'flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border',
              allEligible.length === 0 ? 'opacity-50' : 'active:bg-muted',
            )}
          >
            <Text className="text-xs font-medium text-foreground">
              {selected.size === allEligible.length && allEligible.length > 0
                ? 'Deselect all'
                : `Select all eligible (${allEligible.length})`}
            </Text>
          </Pressable>
          <Text className="text-xs text-muted-foreground">
            {selected.size} selected
          </Text>
        </View>

        <Pressable
          onPress={onReleaseSelected}
          disabled={selected.size === 0 || releasing}
          className={cn(
            'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
            selected.size === 0 || releasing
              ? 'bg-primary/40'
              : 'bg-primary active:opacity-80',
          )}
        >
          {releasing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Banknote size={14} color="#fff" />
          )}
          <Text className="text-sm font-semibold text-primary-foreground">
            {releasing
              ? 'Releasing…'
              : `Release${selected.size > 0 ? ` ${selected.size}` : ''}`}
          </Text>
        </Pressable>
      </View>

      {results && (
        <View className="mb-3 rounded-lg border border-border bg-card p-3">
          <Text className="text-xs font-semibold text-foreground mb-1">Last release results</Text>
          <Text className="text-xs text-muted-foreground">
            {results.filter((r) => r.success).length} succeeded ·{' '}
            {results.filter((r) => !r.success).length} failed
          </Text>
        </View>
      )}

      <FlatList
        data={rows ?? []}
        keyExtractor={(it) => it.creatorId}
        renderItem={renderRow}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          loading ? null : (
            <View className="items-center justify-center py-16">
              <DollarSign size={32} className="text-muted-foreground/50 mb-2" />
              <Text className="text-sm text-muted-foreground">No pending payouts</Text>
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      />
      {loading && !refreshing && (
        <View className="absolute inset-0 items-center justify-center bg-background/80">
          <ActivityIndicator size="large" />
        </View>
      )}
      <HoldModal
        visible={!!holdTarget}
        creator={holdTarget}
        busy={holdBusy}
        onCancel={() => setHoldTarget(null)}
        onSubmit={onSubmitHold}
      />
    </>
  )
}

function HistoryTab({ isWide }: { isWide: boolean }) {
  const [creatorFilter, setCreatorFilter] = useState('')
  const [appliedCreator, setAppliedCreator] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const params: Record<string, string> = { page: String(page), limit: '20' }
    if (appliedCreator) params.creatorId = appliedCreator
    const result = await fetchAdminJson<HistoryResponse>('/payouts/history', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [appliedCreator, page])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const totalPages = data?.totalPages ?? 1

  const renderRow = ({ item }: { item: HistoryRow }) => {
    const isOutflow = item.type === 'refund' || item.type === 'payout' || item.creatorAmountInCents < 0
    const Arrow = isOutflow ? ArrowUpRight : ArrowDownLeft
    return (
      <View
        className={cn(
          'flex-row items-center border-b border-border',
          isWide ? 'px-4 py-3' : 'p-3',
        )}
      >
        <View
          className={cn(
            'h-9 w-9 rounded-lg items-center justify-center mr-3',
            isOutflow ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-green-100 dark:bg-green-900/30',
          )}
        >
          <Arrow
            size={14}
            className={cn(isOutflow ? 'text-amber-600' : 'text-green-600')}
          />
        </View>

        <View className={cn('min-w-0 mr-2', isWide ? 'w-[220px]' : 'flex-1')}>
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {item.creator?.displayName ?? 'Unknown creator'}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {item.listing?.title ?? '—'}
          </Text>
        </View>

        {isWide && (
          <View className="w-[100px] mr-3">
            <Text className="text-xs font-medium text-foreground capitalize">{item.type}</Text>
            <Text className="text-[11px] text-muted-foreground capitalize">{item.status}</Text>
          </View>
        )}

        <View className={cn('w-[110px] mr-3')}>
          <Text className="text-sm font-semibold text-foreground text-right">
            {formatCents(item.amountInCents)}
          </Text>
          {isWide && (
            <Text className="text-[10px] text-muted-foreground text-right">
              fee {formatCents(item.platformFeeInCents)}
            </Text>
          )}
        </View>

        {isWide && (
          <Text className="text-[11px] font-mono text-muted-foreground w-[170px] mr-3" numberOfLines={1}>
            {item.stripeTransferId ?? '—'}
          </Text>
        )}

        <Text className="text-xs text-muted-foreground w-[90px] text-right ml-auto">
          {formatRelative(item.createdAt)}
        </Text>
      </View>
    )
  }

  return (
    <>
      <View className="flex-row items-center gap-2 mb-3">
        <View className="flex-row items-center border border-border rounded-lg px-3 py-2 bg-card flex-1">
          <TextInput
            placeholder="Filter by creatorId (optional)"
            placeholderTextColor="#9ca3af"
            value={creatorFilter}
            onChangeText={setCreatorFilter}
            autoCapitalize="none"
            autoCorrect={false}
            className="flex-1 text-foreground text-sm"
          />
        </View>
        <Pressable
          onPress={() => {
            const trimmed = creatorFilter.trim()
            setAppliedCreator(trimmed === '' ? null : trimmed)
            setPage(1)
          }}
          className="px-3 py-2 rounded-lg bg-primary active:opacity-80"
        >
          <Text className="text-sm font-medium text-primary-foreground">Apply</Text>
        </Pressable>
        {appliedCreator && (
          <Pressable
            onPress={() => {
              setCreatorFilter('')
              setAppliedCreator(null)
              setPage(1)
            }}
            className="px-3 py-2 rounded-lg border border-border active:bg-muted"
          >
            <Text className="text-sm font-medium text-foreground">Clear</Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={data?.items ?? []}
        keyExtractor={(it) => it.id}
        renderItem={renderRow}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          loading ? null : (
            <View className="items-center justify-center py-16">
              <History size={32} className="text-muted-foreground/50 mb-2" />
              <Text className="text-sm text-muted-foreground">No payout history</Text>
            </View>
          )
        }
        ListFooterComponent={
          totalPages > 1 ? (
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
          ) : null
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      />
      {loading && !refreshing && (
        <View className="absolute inset-0 items-center justify-center bg-background/80">
          <ActivityIndicator size="large" />
        </View>
      )}
    </>
  )
}

export default function MarketplacePayoutsPage() {
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [tab, setTab] = useState<'pending' | 'history'>('pending')

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-3')}>
      <View className="gap-3 mb-3">
        <Text className="text-xl font-semibold text-foreground">Payouts</Text>
        <View className="flex-row items-center bg-muted rounded-lg p-0.5 self-start">
          {([
            { id: 'pending', label: 'Pending', icon: Banknote },
            { id: 'history', label: 'History', icon: History },
          ] as const).map((opt) => {
            const Icon = opt.icon
            const active = tab === opt.id
            return (
              <Pressable
                key={opt.id}
                onPress={() => setTab(opt.id)}
                className={cn(
                  'flex-row items-center gap-1.5 px-3 py-1.5 rounded-md',
                  active ? 'bg-background shadow-sm' : '',
                )}
              >
                <Icon size={13} className={active ? 'text-foreground' : 'text-muted-foreground'} />
                <Text
                  className={cn(
                    'text-xs font-medium',
                    active ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {opt.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </View>

      <View className="flex-1">
        {tab === 'pending' ? <PendingTab isWide={isWide} /> : <HistoryTab isWide={isWide} />}
      </View>
    </View>
  )
}
