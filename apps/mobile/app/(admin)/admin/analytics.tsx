// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Marketing Analytics - growth & acquisition insights.
 *
 * One half of the split analytics surface (see ai-analytics.tsx for the
 * AI / engineering half). Focuses on funnel, acquisition sources, per-user
 * activity, and the AI insights digest.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Users,
  Building2,
  FolderKanban,
  MessageSquare,
  Calendar,
  CalendarDays,
  BarChart3,
  Sparkles,
  HardDrive,
  Server,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  type AnalyticsPeriod,
  type FunnelData,
  type UserActivityData,
  type SourceBreakdownData,
  type AIDigestData,
  type AIDigestListItem,
  type ActivityTimeseriesPoint,
  type ActiveUsersTimeseriesPoint,
  StatCard,
  FunnelSection,
  UserActivityTable,
  SourceBreakdownPanel,
  AIInsightsPanel,
  ActivityTrendsChart,
  ActiveUsersTrendChart,
} from '../../../components/analytics/SharedAnalytics'
import { API_BASE, fetchAdminJson, AnalyticsHeader } from '../_analytics-shared'
import { usePanelSequence, SUPERSEDED } from '../_panel-sequence'
import { ComputePanel } from '../../../components/analytics/ComputePanel'

// =============================================================================
// Marketing-specific types
// =============================================================================

interface OverviewData {
  totalUsers: number
  totalWorkspaces: number
  totalProjects: number
  totalChatSessions: number
  activeUsersLast30d?: number
  newUsersLast30d?: number
}

interface ActiveUsersData {
  dau: number
  wau: number
  mau: number
}

/** GET /api/admin/storage — platform S3 metering (SHO-423). */
interface StorageSummaryData {
  lastPassAt: string | null
  buckets: { measuredBytes: number; workspaces: number }
  categories: Record<string, number>
  billableBytes: number
  overheadBytes: number
  unmeasured: string[]
  month: { gbMonths: number; shadowUsd: number; chargedUsd: number; mode: 'shadow' | 'enforce' }
  topByBytes: Array<{ workspaceId: string; name: string; totalBytes: number; billableBytes: number; allowanceBytes: number }>
  topByOverage: Array<{ workspaceId: string; name: string; totalBytes: number; overageBytes: number; allowanceBytes: number }>
}

// =============================================================================
// Marketing-specific components
// =============================================================================

function OverviewCards({ data, loading }: { data: OverviewData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="flex-row flex-wrap gap-2">
        {[1, 2, 3, 4].map((i) => (
          <View key={i} className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-3 h-16" />
        ))}
      </View>
    )
  }
  return (
    <View className="flex-row flex-wrap gap-2">
      <StatCard
        label="Total Users"
        value={data?.totalUsers}
        icon={Users}
        subtitle={data?.newUsersLast30d ? `+${data.newUsersLast30d} last 30d` : undefined}
      />
      <StatCard label="Workspaces" value={data?.totalWorkspaces} icon={Building2} />
      <StatCard label="Projects" value={data?.totalProjects} icon={FolderKanban} />
      <StatCard
        label="Chat Sessions"
        value={data?.totalChatSessions}
        icon={MessageSquare}
        subtitle={data?.activeUsersLast30d ? `${data.activeUsersLast30d} active` : undefined}
      />
    </View>
  )
}

function ActiveUsersSection({ data, loading }: { data: ActiveUsersData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="flex-row gap-2">
          {[1, 2, 3].map((i) => <View key={i} className="flex-1 h-14 bg-muted/50 rounded-lg" />)}
        </View>
      </View>
    )
  }
  const metrics = [
    { label: 'Daily', value: data?.dau, icon: Users },
    { label: 'Weekly', value: data?.wau, icon: Calendar },
    { label: 'Monthly', value: data?.mau, icon: CalendarDays },
  ]
  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">Active Users</Text>
      <View className="flex-row gap-2">
        {metrics.map((m) => {
          const Icon = m.icon
          return (
            <View key={m.label} className="flex-1 flex-row items-center gap-2 p-2 rounded-lg bg-muted/50">
              <View className="h-8 w-8 rounded-lg bg-primary/10 items-center justify-center">
                <Icon size={16} className="text-primary" />
              </View>
              <View>
                <Text className="text-base font-bold text-foreground">
                  {m.value !== undefined ? m.value.toLocaleString() : '—'}
                </Text>
                <Text className="text-[10px] text-muted-foreground">{m.label}</Text>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// =============================================================================
// Main Page
// =============================================================================

const STORAGE_CATEGORY_ROWS: Array<{ key: string; label: string }> = [
  { key: 'project_files', label: 'Project files' },
  { key: 'repo', label: 'Git & LFS' },
  { key: 'assets', label: 'Assets' },
  { key: 'backups', label: 'Backups' },
  { key: 'chat_files', label: 'Chats' },
  { key: 'workspace_root', label: 'Workspace drive' },
  { key: 'published', label: 'Published' },
  { key: 'bucket', label: 'Project buckets' },
  { key: 'quarantine', label: 'Quarantine (overhead)' },
  { key: 'vm_snapshots', label: 'VM snapshots (overhead)' },
]

function formatStorageBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const gb = value / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  const mb = value / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(0)} MB`
  return `${(value / 1024).toFixed(0)} KB`
}

/**
 * A rolling deploy can hand us an older pod's answer (or a mock's `{ ok: true }`),
 * so never trust that a truthy payload is a summary: every field below is read
 * unconditionally, and a missing `month` used to throw inside render.
 */
function isStorageSummary(
  data: StorageSummaryData | null | undefined,
): data is StorageSummaryData {
  if (!data || typeof data !== 'object') return false
  const { month, buckets, categories } = data
  return (
    !!month &&
    typeof month.mode === 'string' &&
    typeof month.gbMonths === 'number' &&
    typeof month.shadowUsd === 'number' &&
    typeof month.chargedUsd === 'number' &&
    !!buckets &&
    typeof buckets.measuredBytes === 'number' &&
    typeof buckets.workspaces === 'number' &&
    !!categories &&
    typeof categories === 'object' &&
    typeof data.billableBytes === 'number' &&
    typeof data.overheadBytes === 'number' &&
    Array.isArray(data.unmeasured) &&
    Array.isArray(data.topByBytes) &&
    Array.isArray(data.topByOverage)
  )
}

/**
 * Platform S3 footprint (SHO-423): what every workspace's bytes add up to by
 * category, how much of it is billable vs our own overhead, and the month's
 * shadow revenue. Read-only — it never triggers a measurement pass.
 */
function StorageSection({
  data,
  loading,
}: {
  data: StorageSummaryData | null
  loading: boolean
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="flex-row flex-wrap gap-2">
          {[1, 2, 3, 4].map((i) => (
            <View key={i} className="flex-1 min-w-[120px] h-14 bg-muted/50 rounded-lg" />
          ))}
        </View>
      </View>
    )
  }
  if (!isStorageSummary(data)) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm text-muted-foreground">Storage data unavailable.</Text>
      </View>
    )
  }

  const modeLabel = data.month.mode === 'shadow' ? 'shadow (not charged)' : 'enforced'
  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap gap-2">
        <StatCard label="Measured" value={formatStorageBytes(data.buckets.measuredBytes)} icon={HardDrive} />
        <StatCard label="Billable" value={formatStorageBytes(data.billableBytes)} icon={BarChart3} />
        <StatCard label="Overhead" value={formatStorageBytes(data.overheadBytes)} icon={Server} />
        <StatCard
          label={`Month ${data.month.mode === 'shadow' ? '(est.)' : ''}`}
          value={`$${data.month.shadowUsd.toFixed(2)}`}
          icon={Sparkles}
        />
      </View>

      <View className="rounded-xl border border-border bg-card p-4">
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-sm font-semibold text-foreground">By category</Text>
          <Text className="text-[11px] text-muted-foreground">
            {data.buckets.workspaces} workspaces · {modeLabel}
          </Text>
        </View>
        <View className="gap-1.5">
          {STORAGE_CATEGORY_ROWS.map((row) => (
            <View key={row.key} className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">{row.label}</Text>
              <Text className="text-sm text-foreground">{formatStorageBytes(data.categories[row.key] ?? 0)}</Text>
            </View>
          ))}
        </View>
        <View className="mt-3 pt-2 border-t border-border gap-1">
          <Text className="text-[11px] text-muted-foreground">
            {data.month.gbMonths.toFixed(3)} billable GB-months this month
            {data.month.mode === 'shadow'
              ? ` · would charge $${data.month.shadowUsd.toFixed(2)}`
              : ` · charged $${data.month.chargedUsd.toFixed(2)}`}
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            Last pass {data.lastPassAt ? new Date(data.lastPassAt).toLocaleString() : 'never'}
          </Text>
          {data.unmeasured.length > 0 && (
            <Text className="text-[11px] text-amber-600 dark:text-amber-400">
              Not measured: {data.unmeasured.join(', ')}
            </Text>
          )}
        </View>
      </View>

      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-[280px] rounded-xl border border-border bg-card p-4">
          <Text className="text-sm font-semibold text-foreground mb-3">Biggest workspaces</Text>
          {data.topByBytes.slice(0, 10).map((row) => (
            <View key={row.workspaceId} className="flex-row items-center justify-between py-1">
              <Text className="text-sm text-foreground flex-1 min-w-0 mr-2" numberOfLines={1}>
                {row.name}
              </Text>
              <Text className="text-sm text-muted-foreground">{formatStorageBytes(row.totalBytes)}</Text>
            </View>
          ))}
          {data.topByBytes.length === 0 && (
            <Text className="text-sm text-muted-foreground">Nothing measured yet.</Text>
          )}
        </View>

        <View className="flex-1 min-w-[280px] rounded-xl border border-border bg-card p-4">
          <Text className="text-sm font-semibold text-foreground mb-3">Over allowance</Text>
          {data.topByOverage.slice(0, 10).map((row) => (
            <View key={row.workspaceId} className="flex-row items-center justify-between py-1">
              <Text className="text-sm text-foreground flex-1 min-w-0 mr-2" numberOfLines={1}>
                {row.name}
              </Text>
              <Text className="text-sm text-muted-foreground">{formatStorageBytes(row.overageBytes)}</Text>
            </View>
          ))}
          {data.topByOverage.length === 0 && (
            <Text className="text-sm text-muted-foreground">No workspace is over its allowance.</Text>
          )}
        </View>
      </View>
    </View>
  )
}

export default function AdminMarketingAnalyticsPage() {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const isWide = width >= 900
  const pagePadding = isWide ? 32 : 16

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [userPage, setUserPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [excludeInternal, setExcludeInternal] = useState(true)
  const [generating, setGenerating] = useState(false)

  const [overview, setOverview] = useState<{ data: OverviewData | null; loading: boolean }>({ data: null, loading: true })
  const [activeUsers, setActiveUsers] = useState<{ data: ActiveUsersData | null; loading: boolean }>({ data: null, loading: true })
  const [activityTs, setActivityTs] = useState<{ data: ActivityTimeseriesPoint[] | null; loading: boolean }>({ data: null, loading: true })
  const [activeUsersTs, setActiveUsersTs] = useState<{ data: ActiveUsersTimeseriesPoint[] | null; loading: boolean }>({ data: null, loading: true })
  const [funnel, setFunnel] = useState<{ data: FunnelData | null; loading: boolean }>({ data: null, loading: true })
  const [userActivity, setUserActivity] = useState<{ data: UserActivityData | null; loading: boolean }>({ data: null, loading: true })
  const [sourceBreakdown, setSourceBreakdown] = useState<{ data: SourceBreakdownData | null; loading: boolean }>({ data: null, loading: true })
  const [aiDigest, setAiDigest] = useState<{ data: AIDigestData | null; loading: boolean }>({ data: null, loading: true })
  const [digestList, setDigestList] = useState<{ data: AIDigestListItem[] | null; loading: boolean }>({ data: null, loading: true })
  const [storage, setStorage] = useState<{ data: StorageSummaryData | null; loading: boolean }>({ data: null, loading: true })

  const internalParam = excludeInternal ? 'true' : 'false'

  /**
   * One loader per panel, each depending only on the params *it* sends (see the
   * same split in ../ai-analytics.tsx): paging the user-activity table used to
   * refetch all nine panels, so one page of twenty rows cost a full platform
   * overview, both timeseries, the funnel, the source breakdown and the digest.
   */
  const trackOverview = usePanelSequence()
  const loadOverview = useCallback(async () => {
    setOverview((s) => ({ ...s, loading: true }))
    const data = await trackOverview(() => fetchAdminJson<OverviewData>('/analytics/overview'))
    if (data === SUPERSEDED) return
    setOverview({ data, loading: false })
  }, [trackOverview])

  const trackActiveUsers = usePanelSequence()
  const loadActiveUsers = useCallback(async () => {
    setActiveUsers((s) => ({ ...s, loading: true }))
    const data = await trackActiveUsers(() => fetchAdminJson<ActiveUsersData>('/analytics/active-users', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setActiveUsers({ data, loading: false })
  }, [period, internalParam, trackActiveUsers])

  const trackActivityTs = usePanelSequence()
  const loadActivityTs = useCallback(async () => {
    setActivityTs((s) => ({ ...s, loading: true }))
    const data = await trackActivityTs(() => fetchAdminJson<ActivityTimeseriesPoint[]>('/analytics/activity-timeseries', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setActivityTs({ data, loading: false })
  }, [period, internalParam, trackActivityTs])

  const trackActiveUsersTs = usePanelSequence()
  const loadActiveUsersTs = useCallback(async () => {
    setActiveUsersTs((s) => ({ ...s, loading: true }))
    const data = await trackActiveUsersTs(() => fetchAdminJson<ActiveUsersTimeseriesPoint[]>('/analytics/active-users-timeseries', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setActiveUsersTs({ data, loading: false })
  }, [period, internalParam, trackActiveUsersTs])

  const trackFunnel = usePanelSequence()
  const loadFunnel = useCallback(async () => {
    setFunnel((s) => ({ ...s, loading: true }))
    const data = await trackFunnel(() => fetchAdminJson<FunnelData>('/analytics/funnel', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setFunnel({ data, loading: false })
  }, [period, internalParam, trackFunnel])

  const trackUserActivity = usePanelSequence()
  const loadUserActivity = useCallback(async () => {
    setUserActivity((s) => ({ ...s, loading: true }))
    const data = await trackUserActivity(() => fetchAdminJson<UserActivityData>('/analytics/user-activity', {
      period,
      excludeInternal: internalParam,
      page: String(userPage),
      limit: '20',
    }))
    if (data === SUPERSEDED) return
    setUserActivity({ data, loading: false })
  }, [period, internalParam, userPage, trackUserActivity])

  const trackSourceBreakdown = usePanelSequence()
  const loadSourceBreakdown = useCallback(async () => {
    setSourceBreakdown((s) => ({ ...s, loading: true }))
    const data = await trackSourceBreakdown(() => fetchAdminJson<SourceBreakdownData>('/analytics/source-breakdown', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setSourceBreakdown({ data, loading: false })
  }, [period, internalParam, trackSourceBreakdown])

  const trackAiDigest = usePanelSequence()
  const loadAiDigest = useCallback(async () => {
    setAiDigest((s) => ({ ...s, loading: true }))
    const data = await trackAiDigest(() => fetchAdminJson<AIDigestData>('/analytics/ai-digest'))
    if (data === SUPERSEDED) return
    setAiDigest({ data, loading: false })
  }, [trackAiDigest])

  const trackDigestList = usePanelSequence()
  const loadDigestList = useCallback(async () => {
    setDigestList((s) => ({ ...s, loading: true }))
    const data = await trackDigestList(() => fetchAdminJson<AIDigestListItem[]>('/analytics/ai-digest/list', { limit: '14' }))
    if (data === SUPERSEDED) return
    setDigestList({ data, loading: false })
  }, [trackDigestList])

  const trackStorage = usePanelSequence()
  const loadStorage = useCallback(async () => {
    setStorage((s) => ({ ...s, loading: true }))
    const data = await trackStorage(() => fetchAdminJson<StorageSummaryData>('/storage'))
    if (data === SUPERSEDED) return
    setStorage({ data, loading: false })
  }, [trackStorage])

  const loadAll = useCallback(async () => {
    await Promise.all([
      loadOverview(),
      loadActiveUsers(),
      loadActivityTs(),
      loadActiveUsersTs(),
      loadFunnel(),
      loadUserActivity(),
      loadSourceBreakdown(),
      loadAiDigest(),
      loadDigestList(),
      loadStorage(),
    ])
  }, [
    loadOverview,
    loadActiveUsers,
    loadActivityTs,
    loadActiveUsersTs,
    loadFunnel,
    loadUserActivity,
    loadSourceBreakdown,
    loadAiDigest,
    loadDigestList,
    loadStorage,
  ])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    void loadActiveUsers()
  }, [loadActiveUsers])

  useEffect(() => {
    void loadActivityTs()
  }, [loadActivityTs])

  useEffect(() => {
    void loadActiveUsersTs()
  }, [loadActiveUsersTs])

  useEffect(() => {
    void loadFunnel()
  }, [loadFunnel])

  useEffect(() => {
    void loadUserActivity()
  }, [loadUserActivity])

  useEffect(() => {
    void loadSourceBreakdown()
  }, [loadSourceBreakdown])

  useEffect(() => {
    void loadAiDigest()
  }, [loadAiDigest])

  useEffect(() => {
    void loadDigestList()
  }, [loadDigestList])

  useEffect(() => {
    void loadStorage()
  }, [loadStorage])

  const handleGenerateDigest = useCallback(async () => {
    setGenerating(true)
    try {
      const res = await fetch(`${API_BASE}/analytics/ai-digest/generate`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        const json = await res.json()
        if (json.data) setAiDigest({ data: json.data, loading: false })
        const dl = await fetchAdminJson<AIDigestListItem[]>('/analytics/ai-digest/list', { limit: '14' })
        setDigestList({ data: dl, loading: false })
      }
    } finally {
      setGenerating(false)
    }
  }, [])

  const handleDigestDateSelect = useCallback(async (date: string) => {
    setAiDigest(s => ({ ...s, loading: true }))
    const dig = await fetchAdminJson<AIDigestData>('/analytics/ai-digest', { date })
    setAiDigest({ data: dig, loading: false })
  }, [])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadAll()
    setRefreshing(false)
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingTop: Math.max(insets.top, 12) + 12,
        paddingHorizontal: pagePadding,
        paddingBottom: Math.max(insets.bottom, 16) + 32,
        width: '100%',
        alignSelf: 'center' as const,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="w-full max-w-[1320px] self-center">
        <View className="rounded-2xl border border-border bg-card px-4 py-4 mb-5 overflow-hidden">
          <View className="flex-row items-center gap-2 mb-2">
            <View className="h-7 w-7 rounded-lg bg-primary/10 items-center justify-center">
              <BarChart3 size={15} className="text-primary" />
            </View>
            <Text className="text-[11px] font-semibold tracking-[1.2px] text-primary uppercase">
              Growth signal
            </Text>
            <View className="ml-auto flex-row items-center gap-1 rounded-full bg-muted px-2 py-1">
              <Sparkles size={11} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">Live workspace view</Text>
            </View>
          </View>
          <AnalyticsHeader
            title="Marketing Analytics"
            subtitle="Growth, acquisition, and engagement signals across the platform"
            isWide={isWide}
            period={period}
            onPeriodChange={setPeriod}
            excludeInternal={excludeInternal}
            onExcludeInternalChange={setExcludeInternal}
          />
        </View>

        {/* Overview cards */}
        <View className="mb-5">
          <SectionLabel title="At a glance" detail="Current platform footprint" />
          <OverviewCards data={overview.data} loading={overview.loading} />
        </View>

        {/* User Funnel */}
        <View className="mb-5">
          <SectionLabel title="Conversion" detail="Where people progress" />
          <FunnelSection data={funnel.data} loading={funnel.loading} />
        </View>

        {/* Active users */}
        <View className="mb-5">
          <SectionLabel title="Audience cadence" detail="Active people over time" />
          <ActiveUsersSection data={activeUsers.data} loading={activeUsers.loading} />
        </View>

        {/* Activity + active-user trends: side-by-side on desktop */}
        <View className="mb-5">
          <SectionLabel title="Momentum" detail="Activity and audience movement" />
          <View className={cn('gap-4', isWide && 'flex-row')}>
            <View className={cn(isWide && 'flex-1')}>
              <ActivityTrendsChart data={activityTs.data} loading={activityTs.loading} />
            </View>
            <View className={cn(isWide && 'flex-1')}>
              <ActiveUsersTrendChart data={activeUsersTs.data} loading={activeUsersTs.loading} />
            </View>
          </View>
        </View>

        {/* User Activity Table */}
        <View className="mb-5">
          <SectionLabel title="People" detail="Recent user activity" />
          <UserActivityTable
            data={userActivity.data}
            loading={userActivity.loading}
            page={userPage}
            onPageChange={setUserPage}
          />
        </View>

        {/* Source breakdown */}
        <View className="mb-5">
          <SectionLabel title="Acquisition" detail="How people find Shogo" />
          <SourceBreakdownPanel data={sourceBreakdown.data} loading={sourceBreakdown.loading} />
        </View>

        {/* Storage footprint (SHO-423) */}
        <View className="mb-5">
          <SectionLabel title="Storage" detail="Platform S3 footprint and month-to-date billing" />
          <StorageSection data={storage.data} loading={storage.loading} />
        </View>

        {/* Compute (SHO-424) */}
        <View className="mb-5">
          <SectionLabel title="Compute" detail="Fleet VM hours, billing and host cost" />
          <ComputePanel />
        </View>

        {/* AI Insights */}
        <View>
          <SectionLabel title="Operator brief" detail="AI-generated insights and decisions" />
          <AIInsightsPanel
            data={aiDigest.data}
            digestList={digestList.data}
            loading={aiDigest.loading}
            onDateSelect={handleDigestDateSelect}
            onGenerate={handleGenerateDigest}
            generating={generating}
          />
        </View>
      </View>
    </ScrollView>
  )
}

function SectionLabel({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="flex-row items-baseline justify-between mb-2 px-1">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      <Text className="text-[11px] text-muted-foreground">{detail}</Text>
    </View>
  )
}
