/**
 * Admin Analytics - Comprehensive platform analytics with usage tables and chat metrics.
 *
 * Converted from apps/web/src/components/admin/pages/AdminAnalytics.tsx
 * Charts are replaced with View-based bar displays and stat cards.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Image,
  RefreshControl,
} from 'react-native'
import {
  Users,
  Building2,
  FolderKanban,
  MessageSquare,
  Calendar,
  CalendarDays,
  Cpu,
  User as UserIcon,
  Zap,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`

// =============================================================================
// Types
// =============================================================================

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

interface UsageData {
  totalCreditsConsumed: number
  actionBreakdown: Array<{ action: string; _count: number }>
  topConsumers: Array<{ workspaceId: string; _sum: { creditsUsed: number | null } }>
}

interface UsageSummaryEntry {
  userId: string
  userName: string | null
  userEmail: string
  userImage: string | null
  model: string
  provider: string
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCredits: number
  avgDurationMs: number
}

interface UsageSummaryData {
  summaries: UsageSummaryEntry[]
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
}

interface UsageLogEntry {
  id: string
  userId: string
  userName: string | null
  userEmail: string
  userImage: string | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  creditCost: number
  durationMs: number
  success: boolean
  createdAt: string
}

interface UsageLogData {
  entries: UsageLogEntry[]
  total: number
  page: number
  limit: number
}

interface ChatAnalytics {
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  avgMessagesPerSession: number
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
// Formatters
// =============================================================================

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

function getModelColor(model: string): string {
  if (model.includes('opus')) return 'bg-purple-500/15 border-purple-500/20'
  if (model.includes('sonnet')) return 'bg-blue-500/15 border-blue-500/20'
  if (model.includes('haiku')) return 'bg-emerald-500/15 border-emerald-500/20'
  if (model.includes('gpt-4o-mini') || model.includes('o1-mini') || model.includes('o3-mini'))
    return 'bg-teal-500/15 border-teal-500/20'
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3'))
    return 'bg-green-500/15 border-green-500/20'
  return 'bg-muted border-border'
}

function getModelTextColor(model: string): string {
  if (model.includes('opus')) return 'text-purple-400'
  if (model.includes('sonnet')) return 'text-blue-400'
  if (model.includes('haiku')) return 'text-emerald-400'
  if (model.includes('gpt-4o-mini') || model.includes('o1-mini') || model.includes('o3-mini'))
    return 'text-teal-400'
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3'))
    return 'text-green-400'
  return 'text-muted-foreground'
}

function getModelDisplayName(model: string): string {
  if (!model) return 'Unknown'
  const map: Record<string, string> = {
    'claude-opus-4-6': 'Opus 4.6',
    'claude-sonnet-4-5': 'Sonnet 4.5',
    'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
    'claude-haiku-4-5': 'Haiku 4.5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-sonnet-4-20250514': 'Sonnet 4',
    'claude-sonnet-4': 'Sonnet 4',
    'claude-3-7-sonnet-20250219': 'Sonnet 3.7',
    'claude-opus-4-20250514': 'Opus 4',
    'claude-opus-4': 'Opus 4',
    'claude-3-haiku-20240307': 'Haiku 3',
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4-turbo': 'GPT-4 Turbo',
    'o1': 'o1',
    'o1-mini': 'o1 Mini',
    'o3-mini': 'o3 Mini',
  }
  return map[model] || (model.length > 20 ? model.slice(0, 20) + '...' : model)
}

// =============================================================================
// Components
// =============================================================================

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
    <View className="flex-1 rounded-xl border border-border bg-card p-3 min-w-[140px]">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-[10px] font-medium text-muted-foreground">{label}</Text>
        <View className="h-6 w-6 rounded bg-primary/10 items-center justify-center">
          <Icon size={12} className="text-primary" />
        </View>
      </View>
      <Text className="text-xl font-bold text-foreground">
        {value !== undefined ? value.toLocaleString() : '—'}
      </Text>
      {subtitle && (
        <Text className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</Text>
      )}
    </View>
  )
}

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

function UsageBreakdownSection({ data, loading }: { data: UsageData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-32 bg-muted rounded mb-3" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  const actions = data?.actionBreakdown ?? []
  const maxCount = Math.max(...actions.map((a) => a._count), 1)

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-sm font-semibold text-foreground">Usage Breakdown</Text>
        {data && (
          <Text className="text-xs text-muted-foreground">
            {data.totalCreditsConsumed.toLocaleString()} credits
          </Text>
        )}
      </View>
      {actions.length === 0 ? (
        <View className="h-32 items-center justify-center">
          <Text className="text-sm text-muted-foreground">No usage data</Text>
        </View>
      ) : (
        <View className="gap-2">
          {actions.slice(0, 8).map((action) => {
            const barWidth = Math.max((action._count / maxCount) * 100, 5)
            return (
              <View key={action.action} className="gap-1">
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs text-foreground" numberOfLines={1}>
                    {action.action || 'unknown'}
                  </Text>
                  <Text className="text-xs font-mono text-muted-foreground">
                    {action._count.toLocaleString()}
                  </Text>
                </View>
                <View className="h-2 bg-muted rounded-full overflow-hidden">
                  <View className="h-full bg-primary rounded-full" style={{ width: `${barWidth}%` }} />
                </View>
              </View>
            )
          })}
        </View>
      )}
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

function ChatAnalyticsSection({ data, loading }: { data: ChatAnalytics | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="flex-row flex-wrap gap-2">
          {[1, 2, 3, 4].map((i) => <View key={i} className="flex-1 min-w-[120px] h-14 bg-muted/50 rounded-lg" />)}
        </View>
      </View>
    )
  }

  if (!data) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-2">Chat Analytics</Text>
        <Text className="text-sm text-muted-foreground">No chat data available</Text>
      </View>
    )
  }

  const stats = [
    { label: 'Total Sessions', value: data.totalSessions.toLocaleString() },
    { label: 'Total Messages', value: data.totalMessages.toLocaleString() },
    { label: 'Tool Calls', value: data.totalToolCalls.toLocaleString() },
    { label: 'Avg Msgs/Session', value: data.avgMessagesPerSession.toFixed(1) },
  ]

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">Chat Analytics</Text>
      <View className="flex-row flex-wrap gap-2">
        {stats.map((s) => (
          <View key={s.label} className="flex-1 min-w-[120px] p-3 rounded-lg bg-muted/50">
            <Text className="text-lg font-bold text-foreground">{s.value}</Text>
            <Text className="text-[10px] text-muted-foreground">{s.label}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

// =============================================================================
// Usage Table - Summary + Event Log views
// =============================================================================

type SortKey = 'userEmail' | 'model' | 'requestCount' | 'totalTokens' | 'totalCredits'

function UsageSummaryView({ data }: { data: UsageSummaryData }) {
  const [sortKey, setSortKey] = useState<SortKey>('totalTokens')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    return [...data.summaries].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      const cmp = typeof va === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data.summaries, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  return (
    <View>
      {/* Totals bar */}
      <View className="flex-row flex-wrap gap-2 mb-4">
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <View className="flex-row items-center gap-1 mb-0.5">
            <UserIcon size={10} className="text-muted-foreground" />
            <Text className="text-[10px] text-muted-foreground">Users</Text>
          </View>
          <Text className="text-base font-bold text-foreground">{data.totals.uniqueUsers}</Text>
        </View>
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <View className="flex-row items-center gap-1 mb-0.5">
            <Cpu size={10} className="text-muted-foreground" />
            <Text className="text-[10px] text-muted-foreground">Models</Text>
          </View>
          <Text className="text-base font-bold text-foreground">{data.totals.uniqueModels}</Text>
        </View>
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <Text className="text-[10px] text-muted-foreground mb-0.5">Requests</Text>
          <Text className="text-base font-bold text-foreground">{formatNumber(data.totals.totalRequests)}</Text>
        </View>
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <Text className="text-[10px] text-muted-foreground mb-0.5">Credits</Text>
          <Text className="text-base font-bold text-foreground">{data.totals.totalCredits.toFixed(1)}</Text>
        </View>
      </View>

      {/* Sortable column headers */}
      <View className="flex-row items-center p-2 bg-muted/30 rounded-t-lg border border-border">
        <Pressable onPress={() => toggleSort('userEmail')} className="flex-1 flex-row items-center gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground">User</Text>
          {sortKey === 'userEmail' ? (
            sortDir === 'asc' ? <ChevronUp size={10} className="text-foreground" /> : <ChevronDown size={10} className="text-foreground" />
          ) : (
            <ArrowUpDown size={10} className="text-muted-foreground opacity-40" />
          )}
        </Pressable>
        <Pressable onPress={() => toggleSort('model')} className="w-20 flex-row items-center gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground">Model</Text>
        </Pressable>
        <Pressable onPress={() => toggleSort('requestCount')} className="w-14 flex-row items-center justify-end gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground">Reqs</Text>
        </Pressable>
        <Pressable onPress={() => toggleSort('totalTokens')} className="w-16 flex-row items-center justify-end gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground">Tokens</Text>
        </Pressable>
        <Pressable onPress={() => toggleSort('totalCredits')} className="w-14 flex-row items-center justify-end gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground">Credits</Text>
        </Pressable>
      </View>

      {/* Rows */}
      {sorted.length === 0 ? (
        <View className="p-8 items-center border border-t-0 border-border rounded-b-lg">
          <Text className="text-sm text-muted-foreground">No usage data for this period</Text>
        </View>
      ) : (
        <View className="border border-t-0 border-border rounded-b-lg overflow-hidden">
          {sorted.map((entry, i) => (
            <View
              key={`${entry.userId}-${entry.model}`}
              className={cn(
                'flex-row items-center p-2 border-b border-border/50',
                i % 2 !== 0 && 'bg-muted/10'
              )}
            >
              {/* User */}
              <View className="flex-1 flex-row items-center gap-1.5 mr-1">
                {entry.userImage ? (
                  <Image source={{ uri: entry.userImage }} className="h-5 w-5 rounded-full" />
                ) : (
                  <View className="h-5 w-5 rounded-full bg-primary/20 items-center justify-center">
                    <Text className="text-[8px] font-medium text-primary">
                      {(entry.userName || entry.userEmail)[0]?.toUpperCase()}
                    </Text>
                  </View>
                )}
                <View className="flex-1 min-w-0">
                  <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
                    {entry.userName || entry.userEmail.split('@')[0]}
                  </Text>
                </View>
              </View>
              {/* Model */}
              <View className={cn('w-20 px-1.5 py-0.5 rounded border', getModelColor(entry.model))}>
                <Text className={cn('text-[9px] font-medium', getModelTextColor(entry.model))} numberOfLines={1}>
                  {getModelDisplayName(entry.model)}
                </Text>
              </View>
              {/* Requests */}
              <Text className="w-14 text-right text-[10px] font-mono text-foreground">
                {entry.requestCount.toLocaleString()}
              </Text>
              {/* Tokens */}
              <Text className="w-16 text-right text-[10px] font-mono text-foreground">
                {formatNumber(entry.totalTokens)}
              </Text>
              {/* Credits */}
              <Text className="w-14 text-right text-[10px] font-mono text-foreground">
                {entry.totalCredits.toFixed(1)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function UsageEventLogView({
  data,
  onPageChange,
  currentPage,
}: {
  data: UsageLogData
  onPageChange?: (p: number) => void
  currentPage: number
}) {
  const totalPages = Math.ceil(data.total / data.limit)

  return (
    <View>
      <Text className="text-xs text-muted-foreground mb-2">
        Showing {data.entries.length} of {data.total.toLocaleString()} events
      </Text>

      {/* Header */}
      <View className="flex-row items-center p-2 bg-muted/30 rounded-t-lg border border-border">
        <Text className="w-16 text-[10px] font-medium text-muted-foreground">Date</Text>
        <Text className="flex-1 text-[10px] font-medium text-muted-foreground">User</Text>
        <Text className="w-20 text-[10px] font-medium text-muted-foreground">Model</Text>
        <Text className="w-14 text-right text-[10px] font-medium text-muted-foreground">Tokens</Text>
        <Text className="w-12 text-right text-[10px] font-medium text-muted-foreground">Cr</Text>
        <View className="w-10 items-end">
          <Clock size={10} className="text-muted-foreground" />
        </View>
      </View>

      {/* Rows */}
      {data.entries.length === 0 ? (
        <View className="p-8 items-center border border-t-0 border-border rounded-b-lg">
          <Text className="text-sm text-muted-foreground">No usage events</Text>
        </View>
      ) : (
        <View className="border border-t-0 border-border rounded-b-lg overflow-hidden">
          {data.entries.map((entry, i) => (
            <View
              key={entry.id}
              className={cn(
                'flex-row items-center p-2 border-b border-border/50',
                i % 2 !== 0 && 'bg-muted/10'
              )}
            >
              <Text className="w-16 text-[9px] text-muted-foreground">
                {new Date(entry.createdAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </Text>
              <View className="flex-1 flex-row items-center gap-1 mr-1">
                {entry.userImage ? (
                  <Image source={{ uri: entry.userImage }} className="h-4 w-4 rounded-full" />
                ) : (
                  <View className="h-4 w-4 rounded-full bg-primary/20 items-center justify-center">
                    <Text className="text-[7px] font-medium text-primary">
                      {(entry.userName || entry.userEmail)[0]?.toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
                  {entry.userName || entry.userEmail.split('@')[0]}
                </Text>
              </View>
              <View className={cn('w-20 px-1 py-0.5 rounded border', getModelColor(entry.model))}>
                <Text className={cn('text-[8px] font-medium', getModelTextColor(entry.model))} numberOfLines={1}>
                  {getModelDisplayName(entry.model)}
                </Text>
              </View>
              <Text className="w-14 text-right text-[10px] font-mono text-muted-foreground">
                {formatNumber(entry.totalTokens)}
              </Text>
              <Text className="w-12 text-right text-[10px] font-mono text-foreground">
                {entry.creditCost.toFixed(1)}
              </Text>
              <Text className="w-10 text-right text-[9px] text-muted-foreground">
                {formatDuration(entry.durationMs)}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <View className="flex-row items-center justify-between mt-3">
          <Text className="text-xs text-muted-foreground">
            Page {currentPage} of {totalPages}
          </Text>
          <View className="flex-row items-center gap-1">
            <Pressable
              onPress={() => onPageChange?.(currentPage - 1)}
              disabled={currentPage <= 1}
              className={cn('p-1.5 rounded-md border border-border', currentPage <= 1 && 'opacity-30')}
            >
              <ChevronLeft size={14} className="text-foreground" />
            </Pressable>
            <Pressable
              onPress={() => onPageChange?.(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className={cn('p-1.5 rounded-md border border-border', currentPage >= totalPages && 'opacity-30')}
            >
              <ChevronRight size={14} className="text-foreground" />
            </Pressable>
          </View>
        </View>
      )}
    </View>
  )
}

function UsageTableSection({
  summaryData,
  logData,
  summaryLoading,
  logLoading,
  onLogPageChange,
  logPage,
}: {
  summaryData: UsageSummaryData | null
  logData: UsageLogData | null
  summaryLoading: boolean
  logLoading: boolean
  onLogPageChange: (p: number) => void
  logPage: number
}) {
  const [view, setView] = useState<'summary' | 'detail'>('summary')

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-sm font-semibold text-foreground">AI Usage by User</Text>
        <View className="flex-row items-center rounded-lg border border-border overflow-hidden">
          <Pressable
            onPress={() => setView('summary')}
            className={cn(
              'px-3 py-1.5',
              view === 'summary' ? 'bg-primary' : ''
            )}
          >
            <Text
              className={cn(
                'text-xs',
                view === 'summary' ? 'text-primary-foreground' : 'text-muted-foreground'
              )}
            >
              Summary
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setView('detail')}
            className={cn(
              'px-3 py-1.5',
              view === 'detail' ? 'bg-primary' : ''
            )}
          >
            <Text
              className={cn(
                'text-xs',
                view === 'detail' ? 'text-primary-foreground' : 'text-muted-foreground'
              )}
            >
              Event Log
            </Text>
          </Pressable>
        </View>
      </View>

      {view === 'summary' ? (
        summaryLoading ? (
          <View className="items-center py-8"><ActivityIndicator /></View>
        ) : summaryData ? (
          <UsageSummaryView data={summaryData} />
        ) : (
          <View className="py-8 items-center">
            <Text className="text-sm text-muted-foreground">No usage data available</Text>
          </View>
        )
      ) : logLoading ? (
        <View className="items-center py-8"><ActivityIndicator /></View>
      ) : logData ? (
        <UsageEventLogView data={logData} onPageChange={onLogPageChange} currentPage={logPage} />
      ) : (
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No usage events available</Text>
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Main Page
// =============================================================================

export default function AdminAnalyticsPage() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [logPage, setLogPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)

  const [overview, setOverview] = useState<{ data: OverviewData | null; loading: boolean }>({ data: null, loading: true })
  const [activeUsers, setActiveUsers] = useState<{ data: ActiveUsersData | null; loading: boolean }>({ data: null, loading: true })
  const [growth, setGrowth] = useState<{ data: GrowthDataPoint[] | null; loading: boolean }>({ data: null, loading: true })
  const [usage, setUsage] = useState<{ data: UsageData | null; loading: boolean }>({ data: null, loading: true })
  const [usageSummary, setUsageSummary] = useState<{ data: UsageSummaryData | null; loading: boolean }>({ data: null, loading: true })
  const [usageLog, setUsageLog] = useState<{ data: UsageLogData | null; loading: boolean }>({ data: null, loading: true })
  const [chatStats, setChatStats] = useState<{ data: ChatAnalytics | null; loading: boolean }>({ data: null, loading: true })

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
      fetchAdminJson<UsageData>('/analytics/usage', pParams),
      fetchAdminJson<UsageSummaryData>('/analytics/usage-summary', pParams),
      fetchAdminJson<UsageLogData>('/analytics/usage-log', { ...pParams, page: String(logPage), limit: '50' }),
      fetchAdminJson<ChatAnalytics>('/analytics/chat', pParams),
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
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-4">
        <View>
          <Text className="text-lg font-bold text-foreground">Analytics</Text>
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

      {/* Growth + Usage breakdown side by side on wider screens, stacked on narrow */}
      <View className="gap-4">
        <GrowthSection data={growth.data} loading={growth.loading} />
        <UsageBreakdownSection data={usage.data} loading={usage.loading} />
      </View>
    </ScrollView>
  )
}
