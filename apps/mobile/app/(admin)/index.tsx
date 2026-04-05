// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Dashboard - Comprehensive overview with business metrics,
 * infrastructure health, AI usage, and historical charts.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
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
  Server,
  Box,
  Cpu,
  Zap,
  Activity,
  Trash2,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
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

interface InfraLiveData {
  snapshot: {
    totalNodes: number
    asgDesired: number
    asgMax: number
    totalPodSlots: number
    usedPodSlots: number
    totalCpuMillis: number
    usedCpuMillis: number
    warmAvailable: number
    warmTarget: number
    warmAssigned: number
    totalProjects: number
    runningProjects: number
    readyProjects: number
    scaledToZero: number
    orphansDeleted: number
    idleEvictions: number
    timestamp: string
  } | null
  live: {
    cluster: {
      totalNodes: number
      asgDesired: number
      asgMax: number
      totalPodSlots: number
      usedPodSlots: number
      totalCpuMillis: number
      usedCpuMillis: number
    } | null
    pool: {
      enabled: boolean
      available: { project: number; agent: number }
      assigned: number
      targetSize: { project: number; agent: number }
    } | null
    gcStats: { orphansDeleted: number; idleEvictions: number; lastGcRun: string | null } | null
  } | null
}

interface InfraHistoryPoint {
  timestamp: string
  totalNodes: number
  warmAvailable: number
  warmTarget: number
  runningProjects: number
  usedPodSlots: number
  totalPodSlots: number
  totalCpuMillis: number
  usedCpuMillis: number
}

interface UsageSummaryData {
  totals: {
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    totalCredits: number
    totalToolCalls: number
    uniqueUsers: number
    uniqueModels: number
  }
  summaries: Array<{
    userId: string
    userName: string
    totalRequests: number
    totalTokens: number
    totalCredits: number
  }>
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

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

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
  value: number | string | undefined
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
        {value !== undefined ? (typeof value === 'number' ? value.toLocaleString() : value) : '—'}
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
      <View className="flex-row gap-3">
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

function UtilizationBar({
  label,
  used,
  total,
  color,
}: {
  label: string
  used: number
  total: number
  color: string
}) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0
  const barColor =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : color

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
        <Text className="text-xs font-semibold text-foreground">
          {used.toLocaleString()} / {total.toLocaleString()} ({pct}%)
        </Text>
      </View>
      <View className="h-2 bg-muted rounded-full overflow-hidden">
        <View className={cn('h-full rounded-full', barColor)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </View>
    </View>
  )
}

function SystemHealthCard({ data, loading }: { data: InfraLiveData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="h-4 w-32 bg-muted rounded mb-4" />
        <View className="gap-4">
          {[1, 2, 3].map((i) => (
            <View key={i} className="h-8 bg-muted/50 rounded" />
          ))}
        </View>
      </View>
    )
  }

  const cluster = data?.live?.cluster ?? data?.snapshot
  const pool = data?.live?.pool
  const snapshot = data?.snapshot

  const warmAvail = pool
    ? (pool.available?.project ?? 0) + (pool.available?.agent ?? 0)
    : (snapshot?.warmAvailable ?? 0)
  const warmTgt = pool
    ? (pool.targetSize?.project ?? 0) + (pool.targetSize?.agent ?? 0)
    : (snapshot?.warmTarget ?? 0)

  const podUsed = cluster?.usedPodSlots ?? 0
  const podTotal = cluster?.totalPodSlots ?? 0
  const cpuUsed = cluster?.usedCpuMillis ?? 0
  const cpuTotal = cluster?.totalCpuMillis ?? 0

  const hasData = cluster || snapshot

  const overallPct = podTotal > 0 ? (podUsed / podTotal) * 100 : 0
  const statusColor =
    !hasData ? 'bg-muted-foreground' :
    overallPct >= 90 ? 'bg-red-500' :
    overallPct >= 70 ? 'bg-yellow-500' :
    'bg-emerald-500'
  const statusLabel =
    !hasData ? 'Unknown' :
    overallPct >= 90 ? 'Critical' :
    overallPct >= 70 ? 'Degraded' :
    'Healthy'

  return (
    <View className="rounded-xl border border-border bg-card p-5">
      <View className="flex-row items-center justify-between mb-4">
        <View className="flex-row items-center gap-2">
          <Activity size={16} className="text-foreground" />
          <Text className="text-sm font-semibold text-foreground">System Health</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <View className={cn('h-2.5 w-2.5 rounded-full', statusColor)} />
          <Text className="text-xs font-medium text-muted-foreground">{statusLabel}</Text>
        </View>
      </View>
      {hasData ? (
        <View className="gap-4">
          <UtilizationBar label="Warm Pool" used={warmAvail} total={warmTgt || warmAvail} color="bg-blue-500" />
          <UtilizationBar label="Pod Slots" used={podUsed} total={podTotal} color="bg-purple-500" />
          <UtilizationBar label="CPU" used={cpuUsed} total={cpuTotal} color="bg-emerald-500" />
        </View>
      ) : (
        <View className="h-24 items-center justify-center">
          <Text className="text-sm text-muted-foreground">No infrastructure data available</Text>
        </View>
      )}
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

function AIUsageSummaryCard({ data, loading }: { data: UsageSummaryData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="h-4 w-32 bg-muted rounded mb-4" />
        <View className="gap-3">
          {[1, 2, 3].map((i) => (
            <View key={i} className="h-6 bg-muted/50 rounded" />
          ))}
        </View>
      </View>
    )
  }

  const totals = data?.totals

  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toLocaleString()
  }

  const items = [
    { label: 'Total Requests', value: totals?.totalRequests ?? 0, icon: Zap, color: 'text-amber-500' },
    { label: 'Total Tokens', value: fmtTokens(totals?.totalTokens ?? 0), icon: Cpu, color: 'text-blue-500' },
    { label: 'Credits Used', value: (totals?.totalCredits ?? 0).toFixed(1), icon: Activity, color: 'text-purple-500' },
    { label: 'Tool Calls', value: totals?.totalToolCalls ?? 0, icon: Box, color: 'text-emerald-500' },
  ]

  return (
    <View className="rounded-xl border border-border bg-card p-5">
      <View className="flex-row items-center gap-2 mb-4">
        <Zap size={16} className="text-foreground" />
        <Text className="text-sm font-semibold text-foreground">AI Usage</Text>
        <Text className="text-xs text-muted-foreground ml-1">
          {totals?.uniqueUsers ?? 0} users · {totals?.uniqueModels ?? 0} models
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-3">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <View key={item.label} className="flex-1 min-w-[120px] p-3 rounded-lg bg-muted/30 border border-border/50">
              <View className="flex-row items-center gap-2 mb-1">
                <Icon size={14} className={item.color} />
                <Text className="text-[11px] text-muted-foreground">{item.label}</Text>
              </View>
              <Text className="text-lg font-bold text-foreground">
                {typeof item.value === 'number' ? item.value.toLocaleString() : item.value}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

function InfraHistoryChart({
  data,
  loading,
}: {
  data: InfraHistoryPoint[] | null
  loading: boolean
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="h-4 w-40 bg-muted rounded mb-4" />
        <View className="h-32 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || data.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-5">
        <View className="flex-row items-center gap-2 mb-3">
          <Server size={16} className="text-foreground" />
          <Text className="text-sm font-semibold text-foreground">Infrastructure History</Text>
        </View>
        <View className="h-24 items-center justify-center">
          <Text className="text-sm text-muted-foreground">
            No historical data yet — snapshots are collected every 60s
          </Text>
        </View>
      </View>
    )
  }

  const maxNodes = Math.max(...data.map((d) => d.totalNodes), 1)
  const maxPods = Math.max(...data.map((d) => d.runningProjects), 1)
  const maxVal = Math.max(maxNodes, maxPods, 1)
  const barCount = Math.min(data.length, 60)
  const step = Math.max(1, Math.floor(data.length / barCount))
  const sampled = data.filter((_, i) => i % step === 0)

  return (
    <View className="rounded-xl border border-border bg-card p-5">
      <View className="flex-row items-center justify-between mb-4">
        <View className="flex-row items-center gap-2">
          <Server size={16} className="text-foreground" />
          <Text className="text-sm font-semibold text-foreground">Infrastructure History (24h)</Text>
        </View>
        <View className="flex-row items-center gap-4">
          <View className="flex-row items-center gap-1.5">
            <View className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            <Text className="text-[11px] text-muted-foreground">Nodes</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <View className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <Text className="text-[11px] text-muted-foreground">Running Pods</Text>
          </View>
        </View>
      </View>
      <View className="flex-row items-end gap-px" style={{ height: 80 }}>
        {sampled.map((point, i) => {
          const nodeH = maxVal > 0 ? (point.totalNodes / maxVal) * 80 : 0
          const podH = maxVal > 0 ? (point.runningProjects / maxVal) * 80 : 0
          return (
            <View key={i} className="flex-1 flex-row items-end gap-px" style={{ height: 80 }}>
              <View className="flex-1 bg-blue-500/70 rounded-t-sm" style={{ height: Math.max(nodeH, 2) }} />
              <View className="flex-1 bg-emerald-500/70 rounded-t-sm" style={{ height: Math.max(podH, 2) }} />
            </View>
          )
        })}
      </View>
      <View className="flex-row justify-between mt-2">
        <Text className="text-[10px] text-muted-foreground">
          {new Date(sampled[0]?.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
        <Text className="text-[10px] text-muted-foreground">
          {new Date(sampled[sampled.length - 1]?.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
    </View>
  )
}

function QuickActionsRow() {
  const router = useRouter()
  const [gcLoading, setGcLoading] = useState(false)
  const [gcResult, setGcResult] = useState<string | null>(null)

  const triggerGc = async () => {
    setGcLoading(true)
    setGcResult(null)
    try {
      const res = await fetch(`${API_BASE}/warm-pool/gc`, {
        method: 'POST',
        credentials: 'include',
      })
      const json = await res.json()
      if (json.ok) {
        setGcResult(`GC done: ${json.orphansDeleted ?? 0} orphans, ${json.idleEvictions ?? 0} idle evicted`)
      } else {
        setGcResult('GC failed')
      }
    } catch {
      setGcResult('GC failed')
    }
    setGcLoading(false)
  }

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Quick Actions</Text>
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          onPress={triggerGc}
          disabled={gcLoading}
          className={cn(
            'flex-row items-center gap-2 px-4 py-2.5 rounded-lg border border-border',
            gcLoading ? 'opacity-50' : 'active:bg-muted/50'
          )}
        >
          <Trash2 size={14} className="text-orange-500" />
          <Text className="text-sm font-medium text-foreground">
            {gcLoading ? 'Running GC...' : 'Trigger GC'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/(admin)/infrastructure' as any)}
          className="flex-row items-center gap-2 px-4 py-2.5 rounded-lg border border-border active:bg-muted/50"
        >
          <Server size={14} className="text-blue-500" />
          <Text className="text-sm font-medium text-foreground">View Infrastructure</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/(admin)/analytics' as any)}
          className="flex-row items-center gap-2 px-4 py-2.5 rounded-lg border border-border active:bg-muted/50"
        >
          <TrendingUp size={14} className="text-emerald-500" />
          <Text className="text-sm font-medium text-foreground">Full Analytics</Text>
        </Pressable>
      </View>
      {gcResult && (
        <Text className="text-xs text-muted-foreground mt-2">{gcResult}</Text>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Skeleton for loading stat cards
// ---------------------------------------------------------------------------

function StatCardSkeleton() {
  return (
    <View className="flex-1 min-w-[160px] rounded-xl border border-border bg-card p-4">
      <View className="h-3 w-16 bg-muted rounded mb-3" />
      <View className="h-7 w-14 bg-muted rounded" />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

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
  const [infra, setInfra] = useState<{ data: InfraLiveData | null; loading: boolean }>({
    data: null,
    loading: true,
  })
  const [infraHistory, setInfraHistory] = useState<{ data: InfraHistoryPoint[] | null; loading: boolean }>({
    data: null,
    loading: true,
  })
  const [usage, setUsage] = useState<{ data: UsageSummaryData | null; loading: boolean }>({
    data: null,
    loading: true,
  })

  const loadData = useCallback(async () => {
    setOverview((s) => ({ ...s, loading: true }))
    setActiveUsers((s) => ({ ...s, loading: true }))
    setGrowth((s) => ({ ...s, loading: true }))
    setInfra((s) => ({ ...s, loading: true }))
    setInfraHistory((s) => ({ ...s, loading: true }))
    setUsage((s) => ({ ...s, loading: true }))

    const [overviewData, activeData, growthData, infraData, infraHistoryData, usageData] =
      await Promise.all([
        fetchAdminJson<OverviewData>('/analytics/overview'),
        fetchAdminJson<ActiveUsersData>('/analytics/active-users', { period }),
        fetchAdminJson<GrowthDataPoint[]>('/analytics/growth', { period }),
        fetchAdminJson<InfraLiveData>('/analytics/infra-current'),
        fetchAdminJson<InfraHistoryPoint[]>('/analytics/infra-history', { period: '24h' }),
        fetchAdminJson<UsageSummaryData>('/analytics/usage-summary', { period }),
      ])

    setOverview({ data: overviewData, loading: false })
    setActiveUsers({ data: activeData, loading: false })
    setGrowth({ data: growthData, loading: false })
    setInfra({ data: infraData, loading: false })
    setInfraHistory({ data: infraHistoryData, loading: false })
    setUsage({ data: usageData, loading: false })
  }, [period])

  useEffect(() => {
    loadData()
  }, [loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  const infraSource = infra.data?.live?.cluster ?? infra.data?.snapshot
  const poolSource = infra.data?.live?.pool
  const warmAvail = poolSource
    ? (poolSource.available?.project ?? 0) + (poolSource.available?.agent ?? 0)
    : (infra.data?.snapshot?.warmAvailable ?? 0)
  const warmTgt = poolSource
    ? (poolSource.targetSize?.project ?? 0) + (poolSource.targetSize?.agent ?? 0)
    : (infra.data?.snapshot?.warmTarget ?? 0)

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
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

      {/* Row 1: Stat cards — business + infra */}
      {overview.loading && infra.loading ? (
        <View className="flex-row flex-wrap gap-3 mb-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <StatCardSkeleton key={i} />
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
          <StatCard
            label="Cluster Nodes"
            value={infraSource?.totalNodes}
            icon={Server}
            subtitle={infraSource ? `${infraSource.asgDesired} / ${infraSource.asgMax} ASG` : undefined}
            accent="bg-cyan-500/10"
            iconColor="text-cyan-500"
          />
          <StatCard
            label="Warm Pool"
            value={warmTgt > 0 ? `${warmAvail} / ${warmTgt}` : warmAvail}
            icon={Box}
            subtitle={warmTgt > 0 ? `${Math.round((warmAvail / warmTgt) * 100)}% available` : undefined}
            accent="bg-amber-500/10"
            iconColor="text-amber-500"
          />
        </View>
      )}

      {/* Row 2: Active Users + System Health */}
      <View className={cn('gap-4 mb-6', isWide ? 'flex-row' : '')}>
        <View className={isWide ? 'flex-1' : ''}>
          <ActiveUsersCard data={activeUsers.data} loading={activeUsers.loading} />
        </View>
        <View className={isWide ? 'flex-1' : ''}>
          <SystemHealthCard data={infra.data} loading={infra.loading} />
        </View>
      </View>

      {/* Row 3: Growth Trends + AI Usage */}
      <View className={cn('gap-4 mb-6', isWide ? 'flex-row' : '')}>
        <View className={isWide ? 'flex-1' : ''}>
          <GrowthSummary data={growth.data} loading={growth.loading} />
        </View>
        <View className={isWide ? 'flex-1' : ''}>
          <AIUsageSummaryCard data={usage.data} loading={usage.loading} />
        </View>
      </View>

      {/* Row 4: Infra history chart */}
      <View className="mb-6">
        <InfraHistoryChart data={infraHistory.data} loading={infraHistory.loading} />
      </View>

      {/* Row 5: Quick actions */}
      <View className="mb-6">
        <QuickActionsRow />
      </View>
    </ScrollView>
  )
}
