// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Marketplace Review Queue.
 *
 * FIFO list of `pending_review` listings from
 * GET /api/admin/marketplace/listings/review-queue. Each row also
 * carries `versions[0]` with `auditFindings`, so we can render the
 * Haiku auditor's severity counts inline without a second round-trip.
 *
 * Approve fires straight (with confirm); Reject opens a modal that
 * collects a required reason — both endpoints already enforce
 * `pending_review` server-side, so we don't need optimistic guards
 * beyond pulling the row out of the list on success.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Modal,
  Alert,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  CheckCircle2,
  XCircle,
  Inbox,
  AlertTriangle,
  KeyRound,
  Info,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

import {
  fetchAdminJson,
  postAdmin,
  formatRelative,
  countFindings,
  AUDIT_PILL,
  type AuditFinding,
  type AuditStatus,
} from './_helpers'

interface ReviewQueueItem {
  id: string
  slug: string
  title: string
  shortDescription: string
  iconUrl: string | null
  currentVersion: string
  status: 'pending_review'
  updatedAt: string
  createdAt: string
  creator: {
    id: string
    displayName: string
    user: { id: string; email: string; name: string | null }
  }
  versions: Array<{
    id: string
    version: string
    changelog: string | null
    auditStatus: AuditStatus
    auditModel: string | null
    auditedAt: string | null
    auditFindings: AuditFinding[] | null
    createdAt: string
  }>
}

interface ReviewQueueResponse {
  items: ReviewQueueItem[]
  total: number
  page: number
  limit: number
  totalPages: number
}

function FindingBadges({ findings }: { findings: AuditFinding[] | null | undefined }) {
  const counts = countFindings(findings)
  if (counts.total === 0) {
    return (
      <View className="flex-row items-center gap-1">
        <CheckCircle2 size={11} className="text-green-600" />
        <Text className="text-[11px] text-muted-foreground">No findings</Text>
      </View>
    )
  }
  return (
    <View className="flex-row items-center gap-2">
      {counts.secret > 0 && (
        <View className="flex-row items-center gap-1">
          <KeyRound size={11} className="text-red-600" />
          <Text className="text-[11px] font-medium text-red-700 dark:text-red-400">
            {counts.secret} secret{counts.secret === 1 ? '' : 's'}
          </Text>
        </View>
      )}
      {counts.non_generic > 0 && (
        <View className="flex-row items-center gap-1">
          <AlertTriangle size={11} className="text-yellow-600" />
          <Text className="text-[11px] font-medium text-yellow-700 dark:text-yellow-400">
            {counts.non_generic} non-generic
          </Text>
        </View>
      )}
      {counts.info > 0 && (
        <View className="flex-row items-center gap-1">
          <Info size={11} className="text-muted-foreground" />
          <Text className="text-[11px] text-muted-foreground">
            {counts.info} info
          </Text>
        </View>
      )}
    </View>
  )
}

function AuditPill({ status }: { status: AuditStatus }) {
  const pill = AUDIT_PILL[status]
  return (
    <View className={cn('px-2 py-0.5 rounded-full', pill.bg)}>
      <Text className="text-[10px] font-medium text-foreground">{pill.label}</Text>
    </View>
  )
}

function RejectModal({
  visible,
  listing,
  busy,
  onCancel,
  onSubmit,
}: {
  visible: boolean
  listing: ReviewQueueItem | null
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
          <Text className="text-base font-semibold text-foreground mb-1">
            Reject listing
          </Text>
          <Text className="text-sm text-muted-foreground mb-4" numberOfLines={2}>
            {listing?.title ?? ''}
          </Text>
          <Text className="text-xs font-medium text-foreground mb-1.5">
            Reason (shown to creator)
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Hard-coded secret in skills/example.ts must be moved to env."
            placeholderTextColor="#9ca3af"
            multiline
            numberOfLines={4}
            editable={!busy}
            className="border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background min-h-[96px]"
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
                <XCircle size={14} color="#fff" />
              )}
              <Text className="text-sm font-semibold text-white">
                {busy ? 'Rejecting…' : 'Reject'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

export default function MarketplaceReviewQueuePage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [data, setData] = useState<ReviewQueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<ReviewQueueItem | null>(null)

  const load = useCallback(async () => {
    const params: Record<string, string> = { page: String(page), limit: '20' }
    const result = await fetchAdminJson<ReviewQueueResponse>('/listings/review-queue', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [page])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const onApprove = async (listing: ReviewQueueItem) => {
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        'Approve listing?',
        `${listing.title} will be published immediately.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Approve', style: 'default', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      )
    })
    if (!proceed) return

    setBusyId(listing.id)
    const res = await postAdmin(`/listings/${listing.id}/approve`, {})
    setBusyId(null)
    if (!res.ok) {
      Alert.alert('Approve failed', res.error ?? 'Unknown error')
      return
    }
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.filter((it) => it.id !== listing.id),
            total: Math.max(0, prev.total - 1),
          }
        : prev,
    )
  }

  const onSubmitReject = async (reason: string) => {
    if (!rejectTarget) return
    if (!reason) return
    setBusyId(rejectTarget.id)
    const res = await postAdmin(`/listings/${rejectTarget.id}/reject`, { reason })
    setBusyId(null)
    if (!res.ok) {
      Alert.alert('Reject failed', res.error ?? 'Unknown error')
      return
    }
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.filter((it) => it.id !== rejectTarget.id),
            total: Math.max(0, prev.total - 1),
          }
        : prev,
    )
    setRejectTarget(null)
  }

  const totalPages = data?.totalPages ?? 1

  const ListHeader = () => (
    <View className="gap-2 mb-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-xl font-semibold text-foreground">Review queue</Text>
        {data && (
          <Text className="text-xs text-muted-foreground">
            {data.total} pending
          </Text>
        )}
      </View>
      <Text className="text-sm text-muted-foreground">
        Oldest submissions first. Audit findings come from the per-version Haiku auditor; they're advisory, not blocking.
      </Text>
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className="flex-row items-center justify-between mt-3 px-1">
        <Text className="text-xs text-muted-foreground">{data?.total ?? 0} pending total</Text>
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
      <Inbox size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">No listings awaiting review</Text>
    </View>
  )

  const renderRow = ({ item }: { item: ReviewQueueItem }) => {
    const v = item.versions[0]
    const isBusy = busyId === item.id

    return (
      <Pressable
        onPress={() => router.push(`/(admin)/marketplace/listing/${item.id}` as any)}
        className={cn(
          'border-b border-border active:bg-muted/30',
          isWide ? 'px-4 py-3' : 'p-3',
        )}
      >
        <View className="flex-row items-start gap-3">
          <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center mt-0.5">
            <Inbox size={16} className="text-primary" />
          </View>

          <View className="flex-1 min-w-0">
            <View className="flex-row items-center gap-2 flex-wrap">
              <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                {item.title}
              </Text>
              <Text className="text-xs text-muted-foreground">v{item.currentVersion}</Text>
              {v && <AuditPill status={v.auditStatus} />}
            </View>
            <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
              {item.creator.displayName} · {item.creator.user.email}
            </Text>
            <View className="mt-1.5 flex-row items-center gap-3 flex-wrap">
              <Text className="text-[11px] text-muted-foreground">
                Submitted {formatRelative(item.updatedAt)}
              </Text>
              <FindingBadges findings={v?.auditFindings ?? null} />
            </View>
          </View>

          {isWide && (
            <View className="flex-row items-center gap-2">
              <Pressable
                onPress={(e) => {
                  e.stopPropagation()
                  setRejectTarget(item)
                }}
                disabled={isBusy}
                className={cn(
                  'flex-row items-center gap-1 px-3 py-1.5 rounded-lg border border-border',
                  isBusy ? 'opacity-50' : 'active:bg-muted',
                )}
              >
                <XCircle size={13} className="text-red-600" />
                <Text className="text-xs font-medium text-foreground">Reject</Text>
              </Pressable>
              <Pressable
                onPress={(e) => {
                  e.stopPropagation()
                  onApprove(item)
                }}
                disabled={isBusy}
                className={cn(
                  'flex-row items-center gap-1 px-3 py-1.5 rounded-lg',
                  isBusy ? 'bg-green-500/40' : 'bg-green-600 active:opacity-80',
                )}
              >
                {isBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <CheckCircle2 size={13} color="#fff" />
                )}
                <Text className="text-xs font-semibold text-white">Approve</Text>
              </Pressable>
            </View>
          )}
        </View>
      </Pressable>
    )
  }

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
      <RejectModal
        visible={!!rejectTarget}
        listing={rejectTarget}
        busy={busyId === rejectTarget?.id}
        onCancel={() => setRejectTarget(null)}
        onSubmit={onSubmitReject}
      />
    </View>
  )
}
