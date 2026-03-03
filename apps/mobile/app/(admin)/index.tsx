/**
 * Admin Dashboard - Main overview page with key metrics, navigation, and charts.
 *
 * Converted from apps/web/src/components/admin/pages/AdminDashboard.tsx
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Users,
  Building2,
  FolderKanban,
  MessageSquare,
  BarChart3,
  ChevronRight,
  Calendar,
  CalendarDays,
  ArrowLeft,
  Shield,
  Server,
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
}: {
  label: string
  value: number | undefined
  icon: React.ComponentType<{ size?: number; className?: string }>
  subtitle?: string
}) {
  return (
    <View className="flex-1 rounded-xl border border-border bg-card p-4 min-w-[140px]">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
        <View className="h-7 w-7 rounded-lg bg-primary/10 items-center justify-center">
          <Icon size={14} className="text-primary" />
        </View>
      </View>
      <Text className="text-2xl font-bold text-foreground tracking-tight">
        {value !== undefined ? value.toLocaleString() : '—'}
      </Text>
      {subtitle && (
        <Text className="text-xs text-muted-foreground mt-1">{subtitle}</Text>
      )}
    </View>
  )
}

function ActiveUsersCard({ data, loading }: { data: ActiveUsersData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-32 bg-muted rounded mb-4" />
        <View className="flex-row gap-3">
          {[1, 2, 3].map((i) => (
            <View key={i} className="flex-1 h-16 bg-muted/50 rounded-lg" />
          ))}
        </View>
      </View>
    )
  }

  const metrics = [
    { label: 'Daily Active', value: data?.dau, icon: Users },
    { label: 'Weekly Active', value: data?.wau, icon: Calendar },
    { label: 'Monthly Active', value: data?.mau, icon: CalendarDays },
  ]

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">Active Users</Text>
      <View className="flex-row gap-3">
        {metrics.map((m) => {
          const Icon = m.icon
          return (
            <View key={m.label} className="flex-1 flex-row items-center gap-2 p-3 rounded-lg bg-muted/50">
              <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center">
                <Icon size={18} className="text-primary" />
              </View>
              <View>
                <Text className="text-lg font-bold text-foreground">
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

function GrowthSummary({ data, loading }: { data: GrowthDataPoint[] | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-32 bg-muted rounded mb-4" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || data.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Growth Trends</Text>
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
    { label: 'Projects', current: latest.projects, start: earliest.projects, color: 'bg-green-500' },
  ]

  const maxVal = Math.max(...data.map((d) => Math.max(d.users, d.workspaces, d.projects)), 1)

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">Growth Trends</Text>
      <View className="gap-3">
        {metrics.map((m) => {
          const growth = m.start > 0 ? (((m.current - m.start) / m.start) * 100).toFixed(0) : '—'
          const barWidth = Math.max((m.current / maxVal) * 100, 5)
          return (
            <View key={m.label} className="gap-1">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs font-medium text-foreground">{m.label}</Text>
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-bold text-foreground">
                    {m.current.toLocaleString()}
                  </Text>
                  {growth !== '—' && (
                    <Text className="text-xs text-green-500">+{growth}%</Text>
                  )}
                </View>
              </View>
              <View className="h-2 bg-muted rounded-full overflow-hidden">
                <View className={cn('h-full rounded-full', m.color)} style={{ width: `${barWidth}%` }} />
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

const NAV_ITEMS = [
  { href: '/(admin)/users', icon: Users, label: 'Users', description: 'Manage platform users' },
  { href: '/(admin)/workspaces', icon: Building2, label: 'Workspaces', description: 'Browse workspaces' },
  { href: '/(admin)/analytics', icon: BarChart3, label: 'Analytics', description: 'Detailed analytics' },
  { href: '/(admin)/infrastructure', icon: Server, label: 'Infrastructure', description: 'Warm pool, nodes, pods' },
] as const

export default function AdminDashboard() {
  const router = useRouter()
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
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-4">
        <View className="flex-row items-center gap-2">
          <Shield size={18} className="text-primary" />
          <View>
            <Text className="text-xl font-bold text-foreground">Dashboard</Text>
            <Text className="text-xs text-muted-foreground">
              Platform overview and key metrics
            </Text>
          </View>
        </View>
      </View>

      {/* Period selector */}
      <View className="mb-4">
        <PeriodSelector value={period} onChange={setPeriod} />
      </View>

      {/* Overview cards */}
      {overview.loading ? (
        <View className="flex-row flex-wrap gap-3 mb-4">
          {[1, 2, 3, 4].map((i) => (
            <View key={i} className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-4">
              <View className="h-3 w-16 bg-muted rounded mb-2" />
              <View className="h-6 w-12 bg-muted rounded" />
            </View>
          ))}
        </View>
      ) : (
        <View className="flex-row flex-wrap gap-3 mb-4">
          <StatCard
            label="Total Users"
            value={overview.data?.totalUsers}
            icon={Users}
            subtitle={overview.data?.newUsersLast30d ? `+${overview.data.newUsersLast30d} last 30d` : undefined}
          />
          <StatCard
            label="Workspaces"
            value={overview.data?.totalWorkspaces}
            icon={Building2}
          />
          <StatCard
            label="Projects"
            value={overview.data?.totalProjects}
            icon={FolderKanban}
          />
          <StatCard
            label="Chat Sessions"
            value={overview.data?.totalChatSessions}
            icon={MessageSquare}
            subtitle={overview.data?.activeUsersLast30d ? `${overview.data.activeUsersLast30d} active` : undefined}
          />
        </View>
      )}

      {/* Active users */}
      <View className="mb-4">
        <ActiveUsersCard data={activeUsers.data} loading={activeUsers.loading} />
      </View>

      {/* Growth summary */}
      <View className="mb-4">
        <GrowthSummary data={growth.data} loading={growth.loading} />
      </View>

      {/* Quick navigation */}
      <View className="gap-2 mb-4">
        <Text className="text-sm font-semibold text-foreground mb-1">Quick Access</Text>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <Pressable
              key={item.href}
              onPress={() => router.push(item.href as any)}
              className="flex-row items-center gap-3 p-4 rounded-xl border border-border bg-card active:bg-muted/50"
            >
              <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
                <Icon size={20} className="text-primary" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">{item.label}</Text>
                <Text className="text-xs text-muted-foreground">{item.description}</Text>
              </View>
              <ChevronRight size={16} className="text-muted-foreground" />
            </Pressable>
          )
        })}
      </View>

      {/* Back to app */}
      <Pressable
        onPress={() => router.replace('/(app)')}
        className="flex-row items-center justify-center gap-2 p-3 rounded-lg border border-border"
      >
        <ArrowLeft size={16} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Back to App</Text>
      </Pressable>
    </ScrollView>
  )
}
