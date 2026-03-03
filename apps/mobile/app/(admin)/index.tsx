/**
 * Admin Dashboard - Main overview page with key metrics and charts.
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
import {
  Users,
  Building2,
  FolderKanban,
  MessageSquare,
  Calendar,
  CalendarDays,
  TrendingUp,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`

type AnalyticsPeriod = '7d' | '30d' | '90d' | '1y'

const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
}

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

function PeriodSelector({
  value,
  onChange,
}: {
  value: AnalyticsPeriod
  onChange: (p: AnalyticsPeriod) => void
}) {
  return (
    <View className="flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {(Object.keys(PERIOD_LABELS) as AnalyticsPeriod[]).map((period) => (
        <Pressable
          key={period}
          onPress={() => onChange(period)}
          className={cn(
            'px-3 py-1.5 rounded-md',
            value === period ? 'bg-background shadow-sm' : ''
          )}
        >
          <Text
            className={cn(
              'text-xs font-medium',
              value === period ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {PERIOD_LABELS[period]}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  subtitle,
  accent = 'bg-primary/10',
  iconColor = 'text-primary',
}: {
  label: string
  value: number | undefined
  icon: React.ComponentType<{ size?: number; className?: string }>
  subtitle?: string
  accent?: string
  iconColor?: string
}) {
  return (
    <View className="flex-1 min-w-[160px] rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</Text>
        <View className={cn('h-8 w-8 rounded-lg items-center justify-center', accent)}>
          <Icon size={16} className={iconColor} />
        </View>
      </View>
      <Text className="text-3xl font-bold text-foreground tracking-tight">
        {value !== undefined ? value.toLocaleString() : '—'}
      </Text>
      {subtitle && (
        <Text className="text-xs text-muted-foreground mt-1">{subtitle}</Text>
      )}
    </View>
  )
}

function ActiveUsersCard({ data, loading, isWide }: { data: ActiveUsersData | null; loading: boolean; isWide: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="h-4 w-32 bg-muted rounded mb-4" />
        <View className="flex-row gap-3">
          {[1, 2, 3].map((i) => (
            <View key={i} className="flex-1 h-20 bg-muted/50 rounded-lg" />
          ))}
        </View>
      </View>
    )
  }

  const metrics = [
    { label: 'Daily Active', value: data?.dau, icon: Users, color: 'text-blue-500', bg: 'bg-blue-500/10' },
    { label: 'Weekly Active', value: data?.wau, icon: Calendar, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    { label: 'Monthly Active', value: data?.mau, icon: CalendarDays, color: 'text-purple-500', bg: 'bg-purple-500/10' },
  ]

  return (
    <View className="rounded-xl border border-border bg-card p-5">
      <Text className="text-sm font-semibold text-foreground mb-4">Active Users</Text>
      <View className={cn('gap-3', isWide ? 'flex-row' : 'flex-row')}>
        {metrics.map((m) => {
          const Icon = m.icon
          return (
            <View key={m.label} className="flex-1 flex-row items-center gap-3 p-4 rounded-xl bg-muted/30 border border-border/50">
              <View className={cn('h-11 w-11 rounded-xl items-center justify-center', m.bg)}>
                <Icon size={20} className={m.color} />
              </View>
              <View>
                <Text className="text-2xl font-bold text-foreground">
                  {m.value !== undefined ? m.value.toLocaleString() : '—'}
                </Text>
                <Text className="text-xs text-muted-foreground">{m.label}</Text>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

function GrowthSummary({ data, loading }: { data: GrowthDataPoint[] | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="h-4 w-32 bg-muted rounded mb-4" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || data.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="flex-row items-center gap-2 mb-3">
          <TrendingUp size={16} className="text-foreground" />
          <Text className="text-sm font-semibold text-foreground">Growth Trends</Text>
        </View>
        <View className="h-32 items-center justify-center">
          <Text className="text-sm text-muted-foreground">No growth data available</Text>
        </View>
      </View>
    )
  }

  const latest = data[data.length - 1]
  const earliest = data[0]
  const metrics = [
    { label: 'Users', current: latest.users, start: earliest.users, color: 'bg-primary' },
    { label: 'Workspaces', current: latest.workspaces, start: earliest.workspaces, color: 'bg-blue-500' },
    { label: 'Projects', current: latest.projects, start: earliest.projects, color: 'bg-emerald-500' },
  ]

  const maxVal = Math.max(...data.map((d) => Math.max(d.users, d.workspaces, d.projects)), 1)

  return (
    <View className="rounded-xl border border-border bg-card p-5">
      <View className="flex-row items-center gap-2 mb-4">
        <TrendingUp size={16} className="text-foreground" />
        <Text className="text-sm font-semibold text-foreground">Growth Trends</Text>
      </View>
      <View className="gap-4">
        {metrics.map((m) => {
          const growth = m.start > 0 ? (((m.current - m.start) / m.start) * 100).toFixed(0) : '—'
          const barWidth = Math.max((m.current / maxVal) * 100, 5)
          return (
            <View key={m.label} className="gap-1.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-medium text-foreground">{m.label}</Text>
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-bold text-foreground">
                    {m.current.toLocaleString()}
                  </Text>
                  {growth !== '—' && (
                    <Text className="text-xs font-medium text-green-500">+{growth}%</Text>
                  )}
                </View>
              </View>
              <View className="h-2.5 bg-muted rounded-full overflow-hidden">
                <View className={cn('h-full rounded-full', m.color)} style={{ width: `${barWidth}%` }} />
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

export default function AdminDashboard() {
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [refreshing, setRefreshing] = useState(false)

  const [overview, setOverview] = useState<{ data: OverviewData | null; loading: boolean }>({
    data: null,
    loading: true,
  })
  const [activeUsers, setActiveUsers] = useState<{ data: ActiveUsersData | null; loading: boolean }>({
    data: null,
    loading: true,
  })
  const [growth, setGrowth] = useState<{ data: GrowthDataPoint[] | null; loading: boolean }>({
    data: null,
    loading: true,
  })

  const loadData = useCallback(async () => {
    setOverview((s) => ({ ...s, loading: true }))
    setActiveUsers((s) => ({ ...s, loading: true }))
    setGrowth((s) => ({ ...s, loading: true }))

    const [overviewData, activeData, growthData] = await Promise.all([
      fetchAdminJson<OverviewData>('/analytics/overview'),
      fetchAdminJson<ActiveUsersData>('/analytics/active-users', { period }),
      fetchAdminJson<GrowthDataPoint[]>('/analytics/growth', { period }),
    ])

    setOverview({ data: overviewData, loading: false })
    setActiveUsers({ data: activeData, loading: false })
    setGrowth({ data: growthData, loading: false })
  }, [period])

  useEffect(() => {
    loadData()
  }, [loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
        maxWidth: 1200,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-6">
        <View>
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
            Dashboard
          </Text>
          <Text className="text-sm text-muted-foreground mt-0.5">
            Platform overview and key metrics
          </Text>
        </View>
        <PeriodSelector value={period} onChange={setPeriod} />
      </View>

      {/* Overview stat cards */}
      {overview.loading ? (
        <View className="flex-row flex-wrap gap-3 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <View key={i} className="flex-1 min-w-[160px] rounded-xl border border-border bg-card p-4">
              <View className="h-3 w-16 bg-muted rounded mb-3" />
              <View className="h-7 w-14 bg-muted rounded" />
            </View>
          ))}
        </View>
      ) : (
        <View className="flex-row flex-wrap gap-3 mb-6">
          <StatCard
            label="Total Users"
            value={overview.data?.totalUsers}
            icon={Users}
            subtitle={overview.data?.newUsersLast30d ? `+${overview.data.newUsersLast30d} last 30d` : undefined}
            accent="bg-blue-500/10"
            iconColor="text-blue-500"
          />
          <StatCard
            label="Workspaces"
            value={overview.data?.totalWorkspaces}
            icon={Building2}
            accent="bg-purple-500/10"
            iconColor="text-purple-500"
          />
          <StatCard
            label="Projects"
            value={overview.data?.totalProjects}
            icon={FolderKanban}
            accent="bg-emerald-500/10"
            iconColor="text-emerald-500"
          />
          <StatCard
            label="Chat Sessions"
            value={overview.data?.totalChatSessions}
            icon={MessageSquare}
            subtitle={overview.data?.activeUsersLast30d ? `${overview.data.activeUsersLast30d} active users` : undefined}
            accent="bg-orange-500/10"
            iconColor="text-orange-500"
          />
        </View>
      )}

      {/* Active users */}
      <View className="mb-6">
        <ActiveUsersCard data={activeUsers.data} loading={activeUsers.loading} isWide={isWide} />
      </View>

      {/* Growth summary */}
      <View className="mb-6">
        <GrowthSummary data={growth.data} loading={growth.loading} />
      </View>
    </ScrollView>
  )
}
