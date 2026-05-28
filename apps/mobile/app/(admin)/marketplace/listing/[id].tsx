// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Marketplace Listing Detail.
 *
 * Single-listing read backed by GET /api/admin/marketplace/listings/:id
 * (added alongside this page; mirrors the include block already used
 * by approve/reject). Renders status-gated actions plus the audit
 * findings + version history pulled in by the same fetch.
 *
 * Status -> available actions:
 *   pending_review -> Approve, Reject (with reason)
 *   published      -> Suspend, Archive, Feature/Unfeature
 *   suspended | rejected | archived -> Republish
 *   draft | in_review -> read-only here (creator-driven states)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ArrowLeft,
  Store,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Pause,
  Archive as ArchiveIcon,
  Sparkles,
  RotateCw,
  KeyRound,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  History,
  User,
  Mail,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

import {
  fetchAdminJson,
  postAdmin,
  formatRelative,
  formatCents,
  countFindings,
  STATUS_PILL,
  AUDIT_PILL,
  type ListingStatus,
  type AuditStatus,
  type AuditFinding,
} from '../_helpers'

interface ListingVersion {
  id: string
  version: string
  changelog: string | null
  auditStatus: AuditStatus
  auditModel: string | null
  auditedAt: string | null
  auditedBy: string | null
  auditFindings: AuditFinding[] | null
  workspaceSnapshotBytes: number | null
  createdAt: string
}

interface AdminListingDetail {
  id: string
  slug: string
  title: string
  shortDescription: string
  longDescription: string | null
  category: string | null
  tags: string[]
  iconUrl: string | null
  screenshotUrls: string[]
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents: number | null
  monthlyPriceInCents: number | null
  annualPriceInCents: number | null
  installModel: 'fork' | 'linked'
  status: ListingStatus
  currentVersion: string
  installCount: number
  averageRating: number
  reviewCount: number
  publishedAt: string | null
  featuredAt: string | null
  rejectionReason: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  createdAt: string
  updatedAt: string
  creator: {
    id: string
    displayName: string
    user: { id: string; email: string; name: string | null }
  }
  versions: ListingVersion[]
}

function StatusPill({ status }: { status: ListingStatus }) {
  const pill = STATUS_PILL[status]
  return (
    <View className={cn('flex-row items-center gap-1.5 px-2.5 py-1 rounded-full', pill.bg)}>
      <View className={cn('h-1.5 w-1.5 rounded-full', pill.dot)} />
      <Text className="text-[11px] font-medium text-foreground">{pill.label}</Text>
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

function ReasonModal({
  visible,
  title,
  description,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  visible: boolean
  title: string
  description: string
  busy: boolean
  submitLabel: string
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
          <Text className="text-base font-semibold text-foreground mb-1">{title}</Text>
          <Text className="text-sm text-muted-foreground mb-4">{description}</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason"
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
                {busy ? 'Submitting…' : submitLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function FindingItem({ finding }: { finding: AuditFinding }) {
  const [expanded, setExpanded] = useState(false)
  const Icon =
    finding.severity === 'secret'
      ? KeyRound
      : finding.severity === 'non_generic'
        ? AlertTriangle
        : Info
  const tone =
    finding.severity === 'secret'
      ? 'text-red-600'
      : finding.severity === 'non_generic'
        ? 'text-yellow-600'
        : 'text-muted-foreground'
  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      className="border border-border rounded-lg p-3 active:bg-muted/30"
    >
      <View className="flex-row items-start gap-2">
        <Icon size={14} className={cn('mt-0.5', tone)} />
        <View className="flex-1 min-w-0">
          <Text className="text-xs font-mono text-foreground" numberOfLines={1}>
            {finding.file}
            {finding.line != null ? `:${finding.line}` : ''}
          </Text>
          <Text className="text-sm text-foreground mt-0.5">{finding.reason}</Text>
          {expanded && finding.suggestion && (
            <Text className="text-xs text-muted-foreground mt-1.5">
              Suggestion: {finding.suggestion}
            </Text>
          )}
          {expanded && finding.snippet && (
            <View className="mt-2 rounded-md bg-muted/50 p-2">
              <Text className="text-[11px] font-mono text-foreground" numberOfLines={6}>
                {finding.snippet}
              </Text>
            </View>
          )}
        </View>
        {expanded ? (
          <ChevronDown size={14} className="text-muted-foreground mt-0.5" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground mt-0.5" />
        )}
      </View>
    </Pressable>
  )
}

function FindingsSection({ findings }: { findings: AuditFinding[] | null | undefined }) {
  const counts = useMemo(() => countFindings(findings), [findings])
  if (!Array.isArray(findings) || findings.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-1">Audit findings</Text>
        <Text className="text-sm text-muted-foreground">
          No findings reported. The latest version was either not audited or came back clean.
        </Text>
      </View>
    )
  }

  const groups: Array<{ key: AuditFinding['severity']; label: string; items: AuditFinding[] }> = [
    {
      key: 'secret',
      label: `Secrets (${counts.secret})`,
      items: findings.filter((f) => f.severity === 'secret'),
    },
    {
      key: 'non_generic',
      label: `Non-generic content (${counts.non_generic})`,
      items: findings.filter((f) => f.severity === 'non_generic'),
    },
    {
      key: 'info',
      label: `Info (${counts.info})`,
      items: findings.filter((f) => f.severity === 'info'),
    },
  ].filter((g) => g.items.length > 0)

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-sm font-semibold text-foreground">Audit findings</Text>
        <Text className="text-xs text-muted-foreground">
          {counts.total} total · advisory only
        </Text>
      </View>
      <View className="gap-4">
        {groups.map((g) => (
          <View key={g.key} className="gap-2">
            <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {g.label}
            </Text>
            <View className="gap-2">
              {g.items.map((f, idx) => (
                <FindingItem key={`${g.key}-${idx}`} finding={f} />
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

function VersionsSection({ versions }: { versions: ListingVersion[] }) {
  if (versions.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-1">Versions</Text>
        <Text className="text-sm text-muted-foreground">No versions yet.</Text>
      </View>
    )
  }
  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-2 mb-3">
        <History size={14} className="text-muted-foreground" />
        <Text className="text-sm font-semibold text-foreground">Version history</Text>
      </View>
      <View className="gap-2">
        {versions.map((v) => {
          const counts = countFindings(v.auditFindings)
          return (
            <View key={v.id} className="border border-border rounded-lg p-3">
              <View className="flex-row items-center gap-2 flex-wrap">
                <Text className="text-sm font-semibold text-foreground">v{v.version}</Text>
                <AuditPill status={v.auditStatus} />
                <Text className="text-[11px] text-muted-foreground">
                  {formatRelative(v.createdAt)}
                </Text>
                {v.auditModel && (
                  <Text className="text-[11px] text-muted-foreground">· {v.auditModel}</Text>
                )}
              </View>
              {v.changelog && (
                <Text className="text-xs text-muted-foreground mt-1" numberOfLines={3}>
                  {v.changelog}
                </Text>
              )}
              {counts.total > 0 && (
                <Text className="text-[11px] text-muted-foreground mt-1.5">
                  {counts.secret} secret · {counts.non_generic} non-generic · {counts.info} info
                </Text>
              )}
            </View>
          )
        })}
      </View>
    </View>
  )
}

export default function AdminListingDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [listing, setListing] = useState<AdminListingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'suspend' | 'archive' | 'republish' | 'feature' | 'unfeature'>(
    null,
  )
  const [rejectOpen, setRejectOpen] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    const data = await fetchAdminJson<AdminListingDetail>(`/listings/${id}`)
    setListing(data)
    setLoading(false)
  }, [id])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const onApprove = async () => {
    if (!listing) return
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
    setBusy('approve')
    const res = await postAdmin(`/listings/${listing.id}/approve`, {})
    setBusy(null)
    if (!res.ok) {
      Alert.alert('Approve failed', res.error ?? 'Unknown error')
      return
    }
    await load()
  }

  const onReject = async (reason: string) => {
    if (!listing || !reason) return
    setBusy('reject')
    const res = await postAdmin(`/listings/${listing.id}/reject`, { reason })
    setBusy(null)
    if (!res.ok) {
      Alert.alert('Reject failed', res.error ?? 'Unknown error')
      return
    }
    setRejectOpen(false)
    await load()
  }

  const patchStatus = async (
    next: 'published' | 'suspended' | 'archived',
    label: string,
    busyKey: 'suspend' | 'archive' | 'republish',
  ) => {
    if (!listing) return
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        `${label} listing?`,
        `${listing.title} -> ${next}.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: label, style: 'default', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      )
    })
    if (!proceed) return
    setBusy(busyKey)
    const res = await postAdmin(`/listings/${listing.id}/status`, { status: next }, 'PATCH')
    setBusy(null)
    if (!res.ok) {
      Alert.alert(`${label} failed`, res.error ?? 'Unknown error')
      return
    }
    await load()
  }

  const onFeatureToggle = async () => {
    if (!listing) return
    const isFeatured = !!listing.featuredAt
    setBusy(isFeatured ? 'unfeature' : 'feature')
    const res = await postAdmin(
      `/listings/${listing.id}/feature`,
      isFeatured ? { featuredAt: null } : {},
    )
    setBusy(null)
    if (!res.ok) {
      Alert.alert('Feature toggle failed', res.error ?? 'Unknown error')
      return
    }
    await load()
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (!listing) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Store size={32} className="text-muted-foreground mb-2" />
        <Text className="text-sm text-muted-foreground mb-4">Listing not found.</Text>
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg bg-card border border-border active:bg-muted"
        >
          <ArrowLeft size={14} className="text-foreground" />
          <Text className="text-sm font-medium text-foreground">Back</Text>
        </Pressable>
      </View>
    )
  }

  const v = listing.versions[0] ?? null
  const isFeatured = !!listing.featuredAt
  const canApproveReject = listing.status === 'pending_review'
  const canSuspendArchiveFeature = listing.status === 'published'
  const canRepublish =
    listing.status === 'suspended' ||
    listing.status === 'rejected' ||
    listing.status === 'archived'

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingHorizontal: isWide ? 32 : 16,
        paddingVertical: isWide ? 24 : 16,
        paddingBottom: 64,
      }}
    >
      <View className={cn(isWide ? 'mx-auto w-full max-w-4xl' : '')}>
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1.5 mb-4 self-start active:opacity-60"
        >
          <ArrowLeft size={14} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>

        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className="flex-row items-start gap-3">
            <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
              <Store size={18} className="text-primary" />
            </View>
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-2 flex-wrap">
                <Text className="text-lg font-bold text-foreground" numberOfLines={2}>
                  {listing.title}
                </Text>
                <StatusPill status={listing.status} />
                {isFeatured && (
                  <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30">
                    <Sparkles size={11} className="text-amber-600" />
                    <Text className="text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      Featured
                    </Text>
                  </View>
                )}
              </View>
              <Text className="text-xs text-muted-foreground mt-1" numberOfLines={1}>
                {listing.slug} · v{listing.currentVersion}
              </Text>
              <View className="flex-row items-center gap-3 mt-2 flex-wrap">
                <View className="flex-row items-center gap-1">
                  <User size={11} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    {listing.creator.displayName}
                  </Text>
                </View>
                <View className="flex-row items-center gap-1">
                  <Mail size={11} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    {listing.creator.user.email}
                  </Text>
                </View>
              </View>
              {listing.shortDescription && (
                <Text className="text-sm text-foreground mt-3" numberOfLines={3}>
                  {listing.shortDescription}
                </Text>
              )}
              <Pressable
                onPress={() => router.push(`/(app)/marketplace/${listing.slug}` as any)}
                className="flex-row items-center gap-1 mt-3 self-start active:opacity-60"
              >
                <ExternalLink size={12} className="text-primary" />
                <Text className="text-xs font-medium text-primary">View public page</Text>
              </Pressable>
            </View>
          </View>

          <View className="flex-row gap-2 flex-wrap mt-4">
            {canApproveReject && (
              <>
                <Pressable
                  onPress={onApprove}
                  disabled={busy !== null}
                  className={cn(
                    'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
                    busy === 'approve' ? 'bg-green-500/40' : 'bg-green-600 active:opacity-80',
                  )}
                >
                  {busy === 'approve' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <CheckCircle2 size={14} color="#fff" />
                  )}
                  <Text className="text-sm font-semibold text-white">Approve</Text>
                </Pressable>
                <Pressable
                  onPress={() => setRejectOpen(true)}
                  disabled={busy !== null}
                  className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg border border-border active:bg-muted"
                >
                  <XCircle size={14} className="text-red-600" />
                  <Text className="text-sm font-medium text-foreground">Reject…</Text>
                </Pressable>
              </>
            )}

            {canSuspendArchiveFeature && (
              <>
                <Pressable
                  onPress={() => patchStatus('suspended', 'Suspend', 'suspend')}
                  disabled={busy !== null}
                  className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg border border-border active:bg-muted"
                >
                  {busy === 'suspend' ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Pause size={14} className="text-foreground" />
                  )}
                  <Text className="text-sm font-medium text-foreground">Suspend</Text>
                </Pressable>
                <Pressable
                  onPress={() => patchStatus('archived', 'Archive', 'archive')}
                  disabled={busy !== null}
                  className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg border border-border active:bg-muted"
                >
                  {busy === 'archive' ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <ArchiveIcon size={14} className="text-foreground" />
                  )}
                  <Text className="text-sm font-medium text-foreground">Archive</Text>
                </Pressable>
                <Pressable
                  onPress={onFeatureToggle}
                  disabled={busy !== null}
                  className={cn(
                    'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
                    isFeatured
                      ? 'border border-border active:bg-muted'
                      : 'bg-amber-500 active:opacity-80',
                  )}
                >
                  {busy === 'feature' || busy === 'unfeature' ? (
                    <ActivityIndicator size="small" color={isFeatured ? undefined : '#fff'} />
                  ) : (
                    <Sparkles size={14} className={isFeatured ? 'text-foreground' : 'text-white'} />
                  )}
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      isFeatured ? 'text-foreground' : 'text-white',
                    )}
                  >
                    {isFeatured ? 'Unfeature' : 'Feature'}
                  </Text>
                </Pressable>
              </>
            )}

            {canRepublish && (
              <Pressable
                onPress={() => patchStatus('published', 'Republish', 'republish')}
                disabled={busy !== null}
                className={cn(
                  'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
                  busy === 'republish' ? 'bg-green-500/40' : 'bg-green-600 active:opacity-80',
                )}
              >
                {busy === 'republish' ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <RotateCw size={14} color="#fff" />
                )}
                <Text className="text-sm font-semibold text-white">Republish</Text>
              </Pressable>
            )}
          </View>

          {listing.rejectionReason && listing.status === 'rejected' && (
            <View className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <Text className="text-[11px] font-semibold text-red-700 dark:text-red-400 mb-1 uppercase tracking-wide">
                Rejection reason
              </Text>
              <Text className="text-sm text-foreground">{listing.rejectionReason}</Text>
            </View>
          )}
        </View>

        <View className="gap-4">
          <FindingsSection findings={v?.auditFindings} />
          <VersionsSection versions={listing.versions} />

          <View className="rounded-xl border border-border bg-card p-4">
            <Text className="text-sm font-semibold text-foreground mb-3">Metadata</Text>
            <View className={cn(isWide ? 'flex-row flex-wrap gap-y-3' : 'gap-y-3')}>
              <MetaField label="Pricing" value={pricingLabel(listing)} wide={isWide} />
              <MetaField label="Install model" value={listing.installModel} wide={isWide} />
              <MetaField
                label="Installs"
                value={listing.installCount.toLocaleString()}
                wide={isWide}
              />
              <MetaField
                label="Rating"
                value={`${listing.averageRating.toFixed(2)} (${listing.reviewCount})`}
                wide={isWide}
              />
              <MetaField
                label="Published"
                value={listing.publishedAt ? formatRelative(listing.publishedAt) : '—'}
                wide={isWide}
              />
              <MetaField
                label="Featured"
                value={listing.featuredAt ? formatRelative(listing.featuredAt) : '—'}
                wide={isWide}
              />
              <MetaField
                label="Reviewed"
                value={listing.reviewedAt ? formatRelative(listing.reviewedAt) : '—'}
                wide={isWide}
              />
              <MetaField
                label="Reviewed by"
                value={listing.reviewedBy ?? '—'}
                wide={isWide}
                mono
              />
              <MetaField label="Created" value={formatRelative(listing.createdAt)} wide={isWide} />
              <MetaField label="Updated" value={formatRelative(listing.updatedAt)} wide={isWide} />
            </View>
            <Text className="text-[11px] text-muted-foreground font-mono mt-4" numberOfLines={1}>
              ID: {listing.id}
            </Text>
          </View>
        </View>
      </View>

      <ReasonModal
        visible={rejectOpen}
        title="Reject listing"
        description={`${listing.title} — the reason is shown to the creator.`}
        submitLabel="Reject"
        busy={busy === 'reject'}
        onCancel={() => setRejectOpen(false)}
        onSubmit={onReject}
      />
    </ScrollView>
  )
}

function MetaField({
  label,
  value,
  wide,
  mono,
}: {
  label: string
  value: string
  wide: boolean
  mono?: boolean
}) {
  return (
    <View className={cn(wide ? 'w-1/3 pr-3' : '')}>
      <Text className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Text>
      <Text
        className={cn(
          'text-sm text-foreground mt-0.5',
          mono ? 'font-mono text-xs' : '',
        )}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  )
}

function pricingLabel(l: AdminListingDetail): string {
  if (l.pricingModel === 'free') return 'Free'
  if (l.pricingModel === 'subscription') {
    const monthly = l.monthlyPriceInCents != null ? `${formatCents(l.monthlyPriceInCents)}/mo` : null
    const annual = l.annualPriceInCents != null ? `${formatCents(l.annualPriceInCents)}/yr` : null
    return [monthly, annual].filter(Boolean).join(' · ') || 'Subscription'
  }
  return l.priceInCents != null ? formatCents(l.priceInCents) : 'Paid'
}
