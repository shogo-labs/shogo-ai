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
} from '../../components/analytics/SharedAnalytics'
import { API_BASE, fetchAdminJson, AnalyticsHeader } from './_analytics-shared'

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

  const internalParam = excludeInternal ? 'true' : 'false'

  const loadAll = useCallback(async () => {
    const pParams = { period, excludeInternal: internalParam }

    setOverview((s) => ({ ...s, loading: true }))
    setActiveUsers((s) => ({ ...s, loading: true }))
    setActivityTs((s) => ({ ...s, loading: true }))
    setActiveUsersTs((s) => ({ ...s, loading: true }))
    setFunnel((s) => ({ ...s, loading: true }))
    setUserActivity((s) => ({ ...s, loading: true }))
    setSourceBreakdown((s) => ({ ...s, loading: true }))
    setAiDigest((s) => ({ ...s, loading: true }))
    setDigestList((s) => ({ ...s, loading: true }))

    const [ov, au, act, auTs, fn, ua, sb, dig, dl] = await Promise.all([
      fetchAdminJson<OverviewData>('/analytics/overview'),
      fetchAdminJson<ActiveUsersData>('/analytics/active-users', pParams),
      fetchAdminJson<ActivityTimeseriesPoint[]>('/analytics/activity-timeseries', pParams),
      fetchAdminJson<ActiveUsersTimeseriesPoint[]>('/analytics/active-users-timeseries', pParams),
      fetchAdminJson<FunnelData>('/analytics/funnel', pParams),
      fetchAdminJson<UserActivityData>('/analytics/user-activity', { ...pParams, page: String(userPage), limit: '20' }),
      fetchAdminJson<SourceBreakdownData>('/analytics/source-breakdown', pParams),
      fetchAdminJson<AIDigestData>('/analytics/ai-digest'),
      fetchAdminJson<AIDigestListItem[]>('/analytics/ai-digest/list', { limit: '14' }),
    ])

    setOverview({ data: ov, loading: false })
    setActiveUsers({ data: au, loading: false })
    setActivityTs({ data: act, loading: false })
    setActiveUsersTs({ data: auTs, loading: false })
    setFunnel({ data: fn, loading: false })
    setUserActivity({ data: ua, loading: false })
    setSourceBreakdown({ data: sb, loading: false })
    setAiDigest({ data: dig, loading: false })
    setDigestList({ data: dl, loading: false })
  }, [period, userPage, internalParam])

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

  useEffect(() => {
    loadAll()
  }, [loadAll])

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
