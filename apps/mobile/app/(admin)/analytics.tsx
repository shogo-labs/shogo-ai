// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Analytics - Comprehensive platform analytics with usage tables and chat metrics.
 *
 * Converted from apps/web/src/components/admin/pages/AdminAnalytics.tsx
 * Charts are replaced with View-based bar displays and stat cards.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import {
  Users,
  Building2,
  FolderKanban,
  MessageSquare,
  Calendar,
  CalendarDays,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'
import {
  type AnalyticsPeriod,
  type UsageSummaryData,
  type UsageLogData,
  type ChatAnalyticsData,
  type UsageBreakdownData,
  PeriodSelector,
  StatCard,
  UsageTableSection,
  ChatAnalyticsSection,
  UsageBreakdownSection,
} from '../../components/analytics/SharedAnalytics'

const API_BASE = `${API_URL}/api/admin`

// =============================================================================
// Admin-specific types
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

interface GrowthDataPoint {
  date: string
  users: number
  workspaces: number
  projects: number
}

// =============================================================================
// API helpers
// =============================================================================

async function fetchAdminJson<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  try {
    const res = await fetch(`${API_BASE}${path}${qs}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

// =============================================================================
// Admin-specific components
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

function GrowthSection({ data, loading }: { data: GrowthDataPoint[] | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="h-32 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || data.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Growth Trends</Text>
        <View className="h-24 items-center justify-center">
          <Text className="text-sm text-muted-foreground">No data</Text>
        </View>
      </View>
    )
  }

  const latest = data[data.length - 1]
  const earliest = data[0]
  const maxVal = Math.max(latest.users, latest.workspaces, latest.projects, 1)
  const series = [
    { label: 'Users', val: latest.users, start: earliest.users, color: 'bg-primary' },
    { label: 'Workspaces', val: latest.workspaces, start: earliest.workspaces, color: 'bg-blue-500' },
    { label: 'Projects', val: latest.projects, start: earliest.projects, color: 'bg-green-500' },
  ]

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">Growth Trends</Text>
      <View className="gap-3">
        {series.map((s) => {
          const pct = s.start > 0 ? (((s.val - s.start) / s.start) * 100).toFixed(0) : '—'
          const barW = Math.max((s.val / maxVal) * 100, 5)
          return (
            <View key={s.label} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs font-medium text-foreground">{s.label}</Text>
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-bold text-foreground">{s.val.toLocaleString()}</Text>
                  {pct !== '—' && <Text className="text-[10px] text-green-500">+{pct}%</Text>}
                </View>
              </View>
              <View className="h-2 bg-muted rounded-full overflow-hidden">
                <View className={cn('h-full rounded-full', s.color)} style={{ width: `${barW}%` }} />
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

export default function AdminAnalyticsPage() {
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [logPage, setLogPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)

  const [overview, setOverview] = useState<{ data: OverviewData | null; loading: boolean }>({ data: null, loading: true })
  const [activeUsers, setActiveUsers] = useState<{ data: ActiveUsersData | null; loading: boolean }>({ data: null, loading: true })
  const [growth, setGrowth] = useState<{ data: GrowthDataPoint[] | null; loading: boolean }>({ data: null, loading: true })
  const [usage, setUsage] = useState<{ data: UsageBreakdownData | null; loading: boolean }>({ data: null, loading: true })
  const [usageSummary, setUsageSummary] = useState<{ data: UsageSummaryData | null; loading: boolean }>({ data: null, loading: true })
  const [usageLog, setUsageLog] = useState<{ data: UsageLogData | null; loading: boolean }>({ data: null, loading: true })
  const [chatStats, setChatStats] = useState<{ data: ChatAnalyticsData | null; loading: boolean }>({ data: null, loading: true })

  const loadAll = useCallback(async () => {
    const pParams = { period }

    setOverview((s) => ({ ...s, loading: true }))
    setActiveUsers((s) => ({ ...s, loading: true }))
    setGrowth((s) => ({ ...s, loading: true }))
    setUsage((s) => ({ ...s, loading: true }))
    setUsageSummary((s) => ({ ...s, loading: true }))
    setUsageLog((s) => ({ ...s, loading: true }))
    setChatStats((s) => ({ ...s, loading: true }))

    const [ov, au, gr, us, uSum, uLog, ch] = await Promise.all([
      fetchAdminJson<OverviewData>('/analytics/overview'),
      fetchAdminJson<ActiveUsersData>('/analytics/active-users', pParams),
      fetchAdminJson<GrowthDataPoint[]>('/analytics/growth', pParams),
      fetchAdminJson<UsageBreakdownData>('/analytics/usage', pParams),
      fetchAdminJson<UsageSummaryData>('/analytics/usage-summary', pParams),
      fetchAdminJson<UsageLogData>('/analytics/usage-log', { ...pParams, page: String(logPage), limit: '50' }),
      fetchAdminJson<ChatAnalyticsData>('/analytics/chat', pParams),
    ])

    setOverview({ data: ov, loading: false })
    setActiveUsers({ data: au, loading: false })
    setGrowth({ data: gr, loading: false })
    setUsage({ data: us, loading: false })
    setUsageSummary({ data: uSum, loading: false })
    setUsageLog({ data: uLog, loading: false })
    setChatStats({ data: ch, loading: false })
  }, [period, logPage])

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
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
        maxWidth: isWide ? 1200 : undefined,
        width: '100%',
        alignSelf: 'center' as const,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-4">
        <View>
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-lg')}>
            Analytics
          </Text>
          <Text className="text-xs text-muted-foreground">
            Comprehensive platform analytics and insights
          </Text>
        </View>
      </View>

      {/* Period selector */}
      <View className="mb-4">
        <PeriodSelector value={period} onChange={setPeriod} />
      </View>

      {/* Overview cards */}
      <View className="mb-4">
        <OverviewCards data={overview.data} loading={overview.loading} />
      </View>

      {/* Active users */}
      <View className="mb-4">
        <ActiveUsersSection data={activeUsers.data} loading={activeUsers.loading} />
      </View>

      {/* Usage table (summary + event log) */}
      <View className="mb-4">
        <UsageTableSection
          summaryData={usageSummary.data}
          logData={usageLog.data}
          summaryLoading={usageSummary.loading}
          logLoading={usageLog.loading}
          onLogPageChange={setLogPage}
          logPage={logPage}
        />
      </View>

      {/* Chat analytics */}
      <View className="mb-4">
        <ChatAnalyticsSection data={chatStats.data} loading={chatStats.loading} />
      </View>

      {/* Growth + Usage breakdown: side-by-side on desktop, stacked on mobile */}
      <View className={cn('gap-4', isWide && 'flex-row')}>
        <View className={cn(isWide && 'flex-1')}>
          <GrowthSection data={growth.data} loading={growth.loading} />
        </View>
        <View className={cn(isWide && 'flex-1')}>
          <UsageBreakdownSection data={usage.data} loading={usage.loading} />
        </View>
      </View>
    </ScrollView>
  )
}
