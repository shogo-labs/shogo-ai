// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Analytics Components
 *
 * Reusable analytics UI components used by the admin dashboard,
 * workspace settings analytics tab, and user profile usage section.
 */

import { useState, useMemo, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Image,
  Platform,
  Modal,
} from 'react-native'
import {
  Cpu,
  User as UserIcon,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
  TrendingDown,
  Globe,
  Sparkles,
  RefreshCw,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  type ModelFamily,
} from '@shogo/model-catalog'
import { resolveShortName, resolveFamily } from '../../lib/visible-models'
import {
  StackedAreaChart,
  STACKED_PALETTE,
  type StackedSeries,
  type StackedDay,
} from './StackedAreaChart'

// =============================================================================
// Types
// =============================================================================

export type AnalyticsPeriod = '1d' | '7d' | '30d' | '90d' | '1y' | 'mtd' | 'last_month'

export const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  '1d': '1 day',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  'mtd': 'MTD',
  'last_month': 'Last month',
}

export interface UsageSummaryEntry {
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
  totalBilledUsd: number
  totalRawUsd: number
  avgDurationMs: number
}

export interface UsageSummaryData {
  summaries: UsageSummaryEntry[]
  totals: {
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    totalBilledUsd: number
    totalRawUsd: number
    totalToolCalls: number
    uniqueUsers: number
    uniqueModels: number
  }
  /** Total number of aggregated rows across all pages (server-paginated). */
  total?: number
  page?: number
  limit?: number
}

export interface UsageLogEntry {
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
  billedUsd: number
  rawUsd: number
  durationMs: number
  success: boolean
  createdAt: string
}

export interface UsageLogData {
  entries: UsageLogEntry[]
  total: number
  page: number
  limit: number
}

export interface ChatAnalyticsData {
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  avgMessagesPerSession: number
}

export interface UsageBreakdownData {
  totalSpendUsd: number
  actionBreakdown: Array<{ action: string; _count: number }>
  topConsumers?: Array<{ workspaceId: string; totalSpendUsd: number }>
}

// =============================================================================
// Formatters
// =============================================================================

// Backend responses occasionally omit a numeric field (e.g. partial aggregation
// during a refresh or a worker that hadn't computed the value yet). Treat any
// non-finite input as 0 instead of letting `.toFixed` / `.toLocaleString` blow
// up the entire screen — see Sentry JAVASCRIPT-REACT-V (toFixed of undefined
// inside UsageSummaryView).
export function formatNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

export function formatDollarCost(cost: number | null | undefined): string {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return '$0.00'
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

const FAMILY_BG_COLOR: Record<ModelFamily, string> = {
  opus: 'bg-purple-500/15 border-purple-500/20',
  sonnet: 'bg-blue-500/15 border-blue-500/20',
  haiku: 'bg-emerald-500/15 border-emerald-500/20',
  gpt: 'bg-green-500/15 border-green-500/20',
  'o-series': 'bg-teal-500/15 border-teal-500/20',
  other: 'bg-muted border-border',
}

const FAMILY_TEXT_COLOR: Record<ModelFamily, string> = {
  opus: 'text-purple-400',
  sonnet: 'text-blue-400',
  haiku: 'text-emerald-400',
  gpt: 'text-green-400',
  'o-series': 'text-teal-400',
  other: 'text-muted-foreground',
}

export function getModelColor(model: string): string {
  return FAMILY_BG_COLOR[resolveFamily(model) as ModelFamily] ?? 'bg-muted border-border'
}

export function getModelTextColor(model: string): string {
  return FAMILY_TEXT_COLOR[resolveFamily(model) as ModelFamily] ?? 'text-muted-foreground'
}

export const getModelDisplayName = resolveShortName

// =============================================================================
// Components
// =============================================================================

// On native, conditionally toggling NativeWind's `shadow-*` classes triggers a
// CSS-interop race condition that crashes with "Couldn't find a navigation context".
// Use an inline style for the shadow on native to avoid the issue.
const periodActiveNativeShadow = Platform.select({
  ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 1 },
  android: { elevation: 1 },
  default: undefined,
})

export function PeriodSelector({
  value,
  onChange,
}: {
  value: AnalyticsPeriod
  onChange: (p: AnalyticsPeriod) => void
}) {
  // Legacy selector — keep the four rolling-window pills only. The new
  // dashboard uses `DateRangePills` which adds 1d / MTD / Last month.
  const legacyPeriods: AnalyticsPeriod[] = ['7d', '30d', '90d', '1y']
  return (
    <View className="flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {legacyPeriods.map((period) => {
        const isActive = value === period
        return (
          <Pressable
            key={period}
            onPress={() => onChange(period)}
            className={cn(
              'px-3 py-1.5 rounded-md',
              isActive ? 'bg-background' : ''
            )}
            style={isActive ? periodActiveNativeShadow : undefined}
          >
            <Text
              className={cn(
                'text-xs font-medium',
                isActive ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {PERIOD_LABELS[period]}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function StatCard({
  label,
  value,
  icon: Icon,
  subtitle,
}: {
  label: string
  value: number | string | undefined
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
        {value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </Text>
      {subtitle && (
        <Text className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</Text>
      )}
    </View>
  )
}

export function UsageBreakdownSection({ data, loading }: { data: UsageBreakdownData | null; loading: boolean }) {
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
            {formatDollarCost(data.totalSpendUsd)} spent
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

export function ChatAnalyticsSection({ data, loading }: { data: ChatAnalyticsData | null; loading: boolean }) {
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
    { label: 'Total Sessions', value: (data.totalSessions ?? 0).toLocaleString() },
    { label: 'Total Messages', value: (data.totalMessages ?? 0).toLocaleString() },
    { label: 'Tool Calls', value: (data.totalToolCalls ?? 0).toLocaleString() },
    { label: 'Avg Msgs/Session', value: (data.avgMessagesPerSession ?? 0).toFixed(1) },
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

type SortKey = 'userEmail' | 'model' | 'requestCount' | 'totalTokens' | 'totalBilledUsd' | 'totalRawUsd'

export function UsageSummaryView({
  data,
  isLocalMode,
  onPageChange,
  currentPage,
}: {
  data: UsageSummaryData
  isLocalMode?: boolean
  onPageChange?: (p: number) => void
  currentPage?: number
}) {
  const [sortKey, setSortKey] = useState<SortKey>('totalTokens')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    return [...(data.summaries ?? [])].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      const cmp = typeof va === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data?.summaries, sortKey, sortDir])

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
          <Text className="text-base font-bold text-foreground">{data.totals?.uniqueUsers ?? 0}</Text>
        </View>
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <View className="flex-row items-center gap-1 mb-0.5">
            <Cpu size={10} className="text-muted-foreground" />
            <Text className="text-[10px] text-muted-foreground">Models</Text>
          </View>
          <Text className="text-base font-bold text-foreground">{data.totals?.uniqueModels ?? 0}</Text>
        </View>
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <Text className="text-[10px] text-muted-foreground mb-0.5">Requests</Text>
          <Text className="text-base font-bold text-foreground">{formatNumber(data.totals?.totalRequests)}</Text>
        </View>
        <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
          <Text className="text-[10px] text-muted-foreground mb-0.5">{isLocalMode ? 'Raw $' : 'Billed $'}</Text>
          <Text className="text-base font-bold text-foreground">
            {formatDollarCost(isLocalMode ? data.totals?.totalRawUsd : data.totals?.totalBilledUsd)}
          </Text>
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
        <Pressable onPress={() => toggleSort(isLocalMode ? 'totalRawUsd' : 'totalBilledUsd')} className="w-14 flex-row items-center justify-end gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground">{isLocalMode ? 'Raw $' : 'Billed $'}</Text>
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
              <View className="flex-1 flex-row items-center gap-1.5 mr-1">
                {entry.userImage ? (
                  <Image source={{ uri: entry.userImage }} className="h-5 w-5 rounded-full" />
                ) : (
                  <View className="h-5 w-5 rounded-full bg-primary/20 items-center justify-center">
                    <Text className="text-[8px] font-medium text-primary">
                      {(entry.userName || entry.userEmail || '?')[0]?.toUpperCase()}
                    </Text>
                  </View>
                )}
                <View className="flex-1 min-w-0">
                  <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
                    {entry.userName || entry.userEmail?.split('@')[0] || '—'}
                  </Text>
                </View>
              </View>
              <View className={cn('w-20 px-1.5 py-0.5 rounded border', getModelColor(entry.model))}>
                <Text className={cn('text-[9px] font-medium', getModelTextColor(entry.model))} numberOfLines={1}>
                  {getModelDisplayName(entry.model)}
                </Text>
              </View>
              <Text className="w-14 text-right text-[10px] font-mono text-foreground">
                {(entry.requestCount ?? 0).toLocaleString()}
              </Text>
              <Text className="w-16 text-right text-[10px] font-mono text-foreground">
                {formatNumber(entry.totalTokens)}
              </Text>
              <Text className="w-14 text-right text-[10px] font-mono text-foreground">
                {formatDollarCost(isLocalMode ? entry.totalRawUsd : entry.totalBilledUsd)}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Server-side pagination (the aggregated list can get long in prod) */}
      {onPageChange && data.total != null && data.limit != null && data.total > data.limit && (() => {
        const page = currentPage ?? data.page ?? 1
        const totalPages = Math.max(1, Math.ceil(data.total / data.limit))
        return (
          <View className="flex-row items-center justify-between mt-3">
            <Text className="text-xs text-muted-foreground">
              Page {page} of {totalPages} · {data.total.toLocaleString()} rows
            </Text>
            <View className="flex-row items-center gap-1">
              <Pressable
                onPress={() => onPageChange(page - 1)}
                disabled={page <= 1}
                className={cn('p-1.5 rounded-md border border-border', page <= 1 && 'opacity-30')}
              >
                <ChevronLeft size={14} className="text-foreground" />
              </Pressable>
              <Pressable
                onPress={() => onPageChange(page + 1)}
                disabled={page >= totalPages}
                className={cn('p-1.5 rounded-md border border-border', page >= totalPages && 'opacity-30')}
              >
                <ChevronRight size={14} className="text-foreground" />
              </Pressable>
            </View>
          </View>
        )
      })()}
    </View>
  )
}

export function UsageEventLogView({
  data,
  onPageChange,
  currentPage,
  isLocalMode,
}: {
  data: UsageLogData
  onPageChange?: (p: number) => void
  currentPage: number
  isLocalMode?: boolean
}) {
  const totalPages = Math.ceil(data.total / data.limit)

  return (
    <View>
      <Text className="text-xs text-muted-foreground mb-2">
        Showing {(data.entries ?? []).length} of {data.total.toLocaleString()} events
      </Text>

      {/* Header */}
      <View className="flex-row items-center p-2 bg-muted/30 rounded-t-lg border border-border">
        <Text className="w-16 text-[10px] font-medium text-muted-foreground">Date</Text>
        <Text className="flex-1 text-[10px] font-medium text-muted-foreground">User</Text>
        <Text className="w-20 text-[10px] font-medium text-muted-foreground">Model</Text>
        <Text className="w-14 text-right text-[10px] font-medium text-muted-foreground">Tokens</Text>
        <Text className="w-12 text-right text-[10px] font-medium text-muted-foreground">{isLocalMode ? 'Raw $' : '$'}</Text>
        <View className="w-10 items-end">
          <Clock size={10} className="text-muted-foreground" />
        </View>
      </View>

      {/* Rows */}
      {(data.entries ?? []).length === 0 ? (
        <View className="p-8 items-center border border-t-0 border-border rounded-b-lg">
          <Text className="text-sm text-muted-foreground">No usage events</Text>
        </View>
      ) : (
        <View className="border border-t-0 border-border rounded-b-lg overflow-hidden">
          {(data.entries ?? []).map((entry, i) => (
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
                      {(entry.userName || entry.userEmail || '?')[0]?.toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
                  {entry.userName || entry.userEmail?.split('@')[0] || '—'}
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
                {formatDollarCost(isLocalMode ? entry.rawUsd : entry.billedUsd)}
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

export function UsageTableSection({
  summaryData,
  logData,
  summaryLoading,
  logLoading,
  onLogPageChange,
  logPage,
  onSummaryPageChange,
  summaryPage,
  title,
  isLocalMode,
}: {
  summaryData: UsageSummaryData | null
  logData: UsageLogData | null
  summaryLoading: boolean
  logLoading: boolean
  onLogPageChange: (p: number) => void
  logPage: number
  onSummaryPageChange?: (p: number) => void
  summaryPage?: number
  title?: string
  isLocalMode?: boolean
}) {
  const [view, setView] = useState<'summary' | 'detail'>('summary')

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-sm font-semibold text-foreground">{title || 'AI Usage by User'}</Text>
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
          <UsageSummaryView
            data={summaryData}
            isLocalMode={isLocalMode}
            onPageChange={onSummaryPageChange}
            currentPage={summaryPage}
          />
        ) : (
          <View className="py-8 items-center">
            <Text className="text-sm text-muted-foreground">No usage data available</Text>
          </View>
        )
      ) : logLoading ? (
        <View className="items-center py-8"><ActivityIndicator /></View>
      ) : logData ? (
        <UsageEventLogView data={logData} onPageChange={onLogPageChange} currentPage={logPage} isLocalMode={isLocalMode} />
      ) : (
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No usage events available</Text>
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Funnel Section
// =============================================================================

export interface FunnelData {
  signups: number
  onboarded: number
  createdProject: number
  sentMessage: number
  engaged: number
  avgMinToFirstProject: number | null
  avgMinToFirstMessage: number | null
}

export function FunnelSection({ data, loading }: { data: FunnelData | null; loading: boolean }) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="flex-row gap-2">
          {[1, 2, 3, 4, 5].map(i => <View key={i} className="flex-1 h-16 bg-muted/50 rounded-lg" />)}
        </View>
      </View>
    )
  }

  if (!data) return null

  const stages = [
    { label: 'Signed Up', value: data.signups },
    { label: 'Onboarded', value: data.onboarded },
    { label: 'Created Project', value: data.createdProject },
    { label: 'Sent Message', value: data.sentMessage },
    { label: 'Engaged (5+)', value: data.engaged },
  ]

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">User Funnel</Text>
      <View className="flex-row gap-2 flex-wrap">
        {stages.map((stage, i) => {
          const pct = data.signups > 0 ? Math.round((stage.value / data.signups) * 100) : 0
          const prev = i > 0 ? stages[i - 1].value : stage.value
          const dropoff = prev > 0 ? Math.round(((prev - stage.value) / prev) * 100) : 0

          return (
            <View key={stage.label} className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/50">
              <Text className="text-lg font-bold text-foreground">{stage.value.toLocaleString()}</Text>
              <Text className="text-[10px] text-muted-foreground">{stage.label}</Text>
              <View className="flex-row items-center gap-1 mt-0.5">
                <Text className="text-[10px] text-muted-foreground">{pct}%</Text>
                {i > 0 && dropoff > 0 && (
                  <Text className="text-[10px] text-red-400">-{dropoff}%</Text>
                )}
              </View>
            </View>
          )
        })}
      </View>
      {(data.avgMinToFirstProject !== null || data.avgMinToFirstMessage !== null) && (
        <View className="flex-row gap-4 mt-3">
          {data.avgMinToFirstProject !== null && (
            <Text className="text-[10px] text-muted-foreground">
              Avg time to first project: {data.avgMinToFirstProject.toFixed(0)}m
            </Text>
          )}
          {data.avgMinToFirstMessage !== null && (
            <Text className="text-[10px] text-muted-foreground">
              Avg time to first message: {data.avgMinToFirstMessage.toFixed(0)}m
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

// =============================================================================
// User Activity Table
// =============================================================================

export interface UserActivityEntry {
  id: string
  name: string | null
  email: string
  sourceTag: string | null
  signupAt: string
  lastActiveAt: string | null
  projects: number
  messages: number
  sessions: number
  toolCalls: number
  spendUsd: number
}

export interface UserActivityData {
  users: UserActivityEntry[]
  total: number
  page?: number
  limit?: number
}

const SOURCE_COLORS: Record<string, string> = {
  'google-ads': 'bg-blue-500/20 text-blue-600',
  'facebook-ads': 'bg-indigo-500/20 text-indigo-600',
  'organic:google': 'bg-green-500/20 text-green-600',
  'direct': 'bg-gray-500/20 text-gray-500',
  'google-oauth': 'bg-orange-500/20 text-orange-600',
  'referral': 'bg-purple-500/20 text-purple-600',
  'unknown': 'bg-gray-400/20 text-gray-400',
}

function SourceBadge({ tag }: { tag: string | null }) {
  const label = tag || 'unknown'
  const colorClass = SOURCE_COLORS[label]
    || (label.startsWith('referral:') ? SOURCE_COLORS.referral
    : label.startsWith('organic:') ? SOURCE_COLORS['organic:google']
    : SOURCE_COLORS.unknown)
  return (
    <View className={cn('px-1.5 py-0.5 rounded', colorClass)}>
      <Text className="text-[9px] font-medium">{label}</Text>
    </View>
  )
}

export function UserActivityTable({
  data,
  loading,
  page = 1,
  onPageChange,
}: {
  data: UserActivityData | null
  loading: boolean
  page?: number
  onPageChange?: (page: number) => void
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || !data.users?.length) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">User Activity</Text>
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No user data</Text>
        </View>
      </View>
    )
  }

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-sm font-semibold text-foreground">User Activity</Text>
        <Text className="text-[10px] text-muted-foreground">{data.total} users</Text>
      </View>

      {/* Header */}
      <View className="flex-row items-center py-1.5 border-b border-border">
        <Text className="flex-[2] text-[10px] font-medium text-muted-foreground">User</Text>
        <Text className="flex-1 text-[10px] font-medium text-muted-foreground">Source</Text>
        <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Projects</Text>
        <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Msgs</Text>
        <Text className="w-16 text-[10px] font-medium text-muted-foreground text-right">Spend</Text>
      </View>

      {/* Rows */}
      {(data.users ?? []).map(u => (
        <View key={u.id} className="flex-row items-center py-2 border-b border-border/50">
          <View className="flex-[2]">
            <Text className="text-xs font-medium text-foreground" numberOfLines={1}>{u.name || '—'}</Text>
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>{u.email}</Text>
          </View>
          <View className="flex-1">
            <SourceBadge tag={u.sourceTag} />
          </View>
          <Text className="w-14 text-xs text-foreground text-right">{u.projects}</Text>
          <Text className="w-14 text-xs text-foreground text-right">{u.messages}</Text>
          <Text className="w-16 text-xs text-foreground text-right">{formatDollarCost(u.spendUsd)}</Text>
        </View>
      ))}

      {/* Pagination */}
      {onPageChange && data.limit != null && data.total > data.limit && (() => {
        const totalPages = Math.max(1, Math.ceil(data.total / data.limit))
        return (
          <View className="flex-row items-center justify-center gap-4 mt-3">
            <Pressable onPress={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>
              <ChevronLeft size={16} className={page <= 1 ? 'text-muted' : 'text-foreground'} />
            </Pressable>
            <Text className="text-xs text-muted-foreground">Page {page} of {totalPages}</Text>
            <Pressable
              onPress={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight size={16} className={page >= totalPages ? 'text-muted' : 'text-foreground'} />
            </Pressable>
          </View>
        )
      })()}
    </View>
  )
}

// =============================================================================
// Source Breakdown Panel
// =============================================================================

export interface SourceBreakdownEntry {
  tag: string
  count: number
  projectRate: number
  messageRate: number
}

export interface SourceBreakdownData {
  sources: SourceBreakdownEntry[]
}

export function SourceBreakdownPanel({
  data,
  loading,
}: {
  data: SourceBreakdownData | null
  loading: boolean
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-36 bg-muted rounded mb-3" />
        <View className="gap-2">
          {[1, 2, 3].map(i => <View key={i} className="h-12 bg-muted/50 rounded-lg" />)}
        </View>
      </View>
    )
  }

  if (!data || !data.sources?.length) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Acquisition Sources</Text>
        <View className="py-4 items-center">
          <Text className="text-sm text-muted-foreground">No attribution data</Text>
        </View>
      </View>
    )
  }

  const total = (data.sources ?? []).reduce((s, r) => s + r.count, 0)

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-2 mb-3">
        <Globe size={14} className="text-muted-foreground" />
        <Text className="text-sm font-semibold text-foreground">Acquisition Sources</Text>
        <Text className="text-[10px] text-muted-foreground ml-auto">{total} total</Text>
      </View>
      <View className="gap-2">
        {(data.sources ?? []).map(s => {
          const pct = total > 0 ? Math.round((s.count / total) * 100) : 0
          return (
            <View key={s.tag} className="flex-row items-center p-2 rounded-lg bg-muted/50 gap-3">
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <SourceBadge tag={s.tag} />
                  <Text className="text-xs font-bold text-foreground">{s.count}</Text>
                  <Text className="text-[10px] text-muted-foreground">({pct}%)</Text>
                </View>
              </View>
              <View className="flex-row gap-3">
                <View className="items-end">
                  <Text className="text-[10px] font-medium text-foreground">{s.projectRate}%</Text>
                  <Text className="text-[9px] text-muted-foreground">project</Text>
                </View>
                <View className="items-end">
                  <Text className="text-[10px] font-medium text-foreground">{s.messageRate}%</Text>
                  <Text className="text-[9px] text-muted-foreground">message</Text>
                </View>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// =============================================================================
// AI Insights Panel
// =============================================================================

export interface AIDigestData {
  id: string
  date: string
  funnelSignups: number
  funnelEngaged: number
  activeUsers: number
  totalMessages: number
  messagesAnalyzed: number
  chunksProcessed: number
  aiInsights: {
    takeaways: string[]
    intents: { category: string; count: number; examples: string[] }[]
    painPoints: string[]
    securityFlags: string[]
  } | null
}

export interface AIDigestListItem {
  id: string
  date: string
  funnelSignups: number
  funnelEngaged: number
  activeUsers: number
  totalMessages: number
  messagesAnalyzed: number
  createdAt: string
}

export function AIInsightsPanel({
  data,
  digestList,
  loading,
  onDateSelect,
  onGenerate,
  generating,
}: {
  data: AIDigestData | null
  digestList: AIDigestListItem[] | null
  loading: boolean
  onDateSelect?: (date: string) => void
  onGenerate?: () => void
  generating?: boolean
}) {
  const [showHistory, setShowHistory] = useState(false)

  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center gap-2">
          <Sparkles size={14} className="text-muted-foreground" />
          <Text className="text-sm font-semibold text-foreground">AI Insights</Text>
          {data && (
            <Text className="text-[10px] text-muted-foreground">
              {new Date(data.date).toLocaleDateString()} · {data.messagesAnalyzed} msgs analyzed
            </Text>
          )}
        </View>
        <View className="flex-row gap-2">
          {onGenerate && (
            <Pressable
              onPress={onGenerate}
              disabled={generating}
              className="flex-row items-center gap-1 px-2 py-1 rounded bg-primary/10"
            >
              <RefreshCw size={10} className={generating ? 'text-muted' : 'text-primary'} />
              <Text className="text-[10px] text-primary">{generating ? 'Generating...' : 'Generate Now'}</Text>
            </Pressable>
          )}
          {digestList && digestList.length > 1 && (
            <Pressable
              onPress={() => setShowHistory(!showHistory)}
              className="px-2 py-1 rounded bg-muted"
            >
              <Text className="text-[10px] text-muted-foreground">{showHistory ? 'Hide' : 'History'}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {showHistory && digestList && (
        <View className="mb-3 gap-1">
          {digestList.map(d => (
            <Pressable
              key={d.id}
              onPress={() => onDateSelect?.(d.date)}
              className="flex-row items-center justify-between p-2 rounded bg-muted/50"
            >
              <Text className="text-[10px] text-foreground">{new Date(d.date).toLocaleDateString()}</Text>
              <Text className="text-[10px] text-muted-foreground">
                {d.funnelSignups} signups · {d.activeUsers} active · {d.messagesAnalyzed} msgs
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {!data ? (
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No digest available</Text>
          {onGenerate && (
            <Text className="text-[10px] text-muted-foreground mt-1">Click "Generate Now" to create one</Text>
          )}
        </View>
      ) : !data.aiInsights ? (
        <View className="py-4 items-center">
          <Text className="text-sm text-muted-foreground">Digest has no AI analysis</Text>
        </View>
      ) : (
        <View className="gap-3">
          {(data.aiInsights.takeaways?.length ?? 0) > 0 && (
            <View>
              <Text className="text-xs font-semibold text-foreground mb-1.5">Key Takeaways</Text>
              {(data.aiInsights.takeaways ?? []).map((t, i) => (
                <View key={i} className="flex-row gap-2 mb-1">
                  <Text className="text-[10px] text-muted-foreground">•</Text>
                  <Text className="text-[10px] text-foreground flex-1">{t}</Text>
                </View>
              ))}
            </View>
          )}

          {(data.aiInsights.intents?.length ?? 0) > 0 && (
            <View>
              <Text className="text-xs font-semibold text-foreground mb-1.5">User Intents</Text>
              <View className="gap-1">
                {(data.aiInsights.intents ?? []).map((intent, i) => (
                  <View key={i} className="flex-row items-center gap-2 p-1.5 rounded bg-muted/30">
                    <Text className="text-xs font-medium text-foreground">{intent.category}</Text>
                    <Text className="text-[10px] text-muted-foreground">×{intent.count}</Text>
                    {intent.examples[0] && (
                      <Text className="text-[10px] text-muted-foreground flex-1" numberOfLines={1}>
                        e.g. {intent.examples[0]}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            </View>
          )}

          {(data.aiInsights.painPoints?.length ?? 0) > 0 && (
            <View>
              <Text className="text-xs font-semibold text-red-400 mb-1.5">Pain Points</Text>
              {(data.aiInsights.painPoints ?? []).map((p, i) => (
                <View key={i} className="flex-row gap-2 mb-1">
                  <Text className="text-[10px] text-red-400">!</Text>
                  <Text className="text-[10px] text-foreground flex-1">{p}</Text>
                </View>
              ))}
            </View>
          )}

          {(data.aiInsights.securityFlags?.length ?? 0) > 0 && (
            <View>
              <Text className="text-xs font-semibold text-orange-400 mb-1.5">Security Flags</Text>
              {(data.aiInsights.securityFlags ?? []).map((f, i) => (
                <View key={i} className="flex-row gap-2 mb-1">
                  <Text className="text-[10px] text-orange-400">⚠</Text>
                  <Text className="text-[10px] text-foreground flex-1">{f}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Timeseries charts — shared by workspace settings + super admin
// =============================================================================

export type SpendGroupBy = 'model' | 'workspace' | 'user' | 'source'
export type SpendMetric = 'spend' | 'tokens' | 'requests'

export interface SpendTimeseriesData {
  days: { date: string; byModel: Record<string, number>; total: number }[]
  totals: {
    totalSpendUsd: number
    totalIncludedUsd: number
    totalOnDemandUsd: number
    uniqueModels: number
  }
  models: string[]
  groupBy: SpendGroupBy
  metric: SpendMetric
}

const GROUP_BY_LABELS: Record<SpendGroupBy, string> = {
  model: 'Model',
  workspace: 'Workspace',
  user: 'User',
  source: 'Source',
}

const METRIC_LABELS: Record<SpendMetric, string> = {
  spend: 'Spend',
  tokens: 'Tokens',
  requests: 'Requests',
}

function chartUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

/** Generic dropdown used by the timeseries chart controls. */
function ChartDropdown<T extends string>({
  value,
  prefix,
  options,
  labels,
  onChange,
}: {
  value: T
  prefix: string
  options: readonly T[]
  labels: Record<T, string>
  onChange: (v: T) => void
}) {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const triggerRef = useRef<View>(null)

  const measureAndToggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    if (triggerRef.current) {
      triggerRef.current.measureInWindow((x, y, width, height) => {
        setLayout({ x, y, width, height })
        setOpen(true)
      })
    } else {
      setOpen(true)
    }
  }

  return (
    <View ref={triggerRef}>
      <Pressable
        onPress={measureAndToggle}
        className="flex-row items-center gap-1.5 px-3 h-8 rounded-md border border-border bg-background"
      >
        <Text className="text-xs text-foreground">{prefix}: {labels[value]}</Text>
        <ChevronDown
          size={12}
          className="text-muted-foreground"
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
      </Pressable>

      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <View className="flex-1">
          <Pressable className="flex-1" onPress={() => setOpen(false)} />
          {layout && (
            <View
              className="min-w-[160px] rounded-md border border-border bg-popover shadow-md overflow-hidden"
              style={{
                position: 'absolute',
                top: layout.y + layout.height + 4,
                left: layout.x + layout.width - Math.max(layout.width, 160),
                width: Math.max(layout.width, 160),
              }}
            >
              {options.map((v) => (
                <Pressable
                  key={v}
                  onPress={() => { onChange(v); setOpen(false) }}
                  className={cn('px-3 py-2', v === value && 'bg-muted')}
                >
                  <Text className="text-xs text-foreground">{prefix}: {labels[v]}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </Modal>
    </View>
  )
}

export function GroupBySelect({
  value,
  onChange,
  options = ['model', 'workspace', 'user', 'source'],
}: {
  value: SpendGroupBy
  onChange: (v: SpendGroupBy) => void
  options?: readonly SpendGroupBy[]
}) {
  return (
    <ChartDropdown
      value={value}
      prefix="Group by"
      options={options}
      labels={GROUP_BY_LABELS}
      onChange={onChange}
    />
  )
}

export function MetricSelect({
  value,
  onChange,
}: {
  value: SpendMetric
  onChange: (v: SpendMetric) => void
}) {
  return (
    <ChartDropdown
      value={value}
      prefix="Metric"
      options={['spend', 'tokens', 'requests']}
      labels={METRIC_LABELS}
      onChange={onChange}
    />
  )
}

/** Pill-style toggle for picking which single series a trend chart displays. */
export function MetricToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string }[]
}) {
  return (
    <View className="flex-row flex-wrap items-center rounded-lg border border-border overflow-hidden">
      {options.map((o, i) => (
        <Pressable
          key={o.id}
          onPress={() => onChange(o.id)}
          className={cn('px-2.5 py-1.5', value === o.id ? 'bg-primary' : '', i > 0 && 'border-l border-border')}
        >
          <Text className={cn('text-[11px]', value === o.id ? 'text-primary-foreground' : 'text-muted-foreground')}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

function buildSpendSeries(data: SpendTimeseriesData | null): StackedSeries[] {
  if (!data) return []
  return data.models.map((m, i) => ({
    id: m,
    label: data.groupBy === 'model' ? resolveShortName(m) : m,
    color: STACKED_PALETTE[i % STACKED_PALETTE.length],
  }))
}

/**
 * Daily consumption stacked-area chart with group-by + metric controls.
 * Shared by the workspace Usage tab and the super-admin analytics page.
 */
export function UsageTimeseriesChart({
  data,
  loading,
  groupBy,
  metric,
  onGroupByChange,
  onMetricChange,
  isLocalMode,
  title = 'Usage Over Time',
  subtitle = 'Daily usage grouped by series',
  groupByOptions,
  height = 260,
  showTotals = true,
  allowCumulative = false,
}: {
  data: SpendTimeseriesData | null
  loading?: boolean
  groupBy: SpendGroupBy
  metric: SpendMetric
  onGroupByChange: (v: SpendGroupBy) => void
  onMetricChange: (v: SpendMetric) => void
  isLocalMode?: boolean
  title?: string
  subtitle?: string
  groupByOptions?: readonly SpendGroupBy[]
  height?: number
  showTotals?: boolean
  /** When true, show a Daily/Cumulative toggle that accumulates each series over the window. */
  allowCumulative?: boolean
}) {
  const [mode, setMode] = useState<'daily' | 'cumulative'>('daily')
  const series = buildSpendSeries(data)
  const dailyDays: StackedDay[] = (data?.days ?? []).map((d) => ({ date: d.date, values: d.byModel }))
  const isCumulative = allowCumulative && mode === 'cumulative'
  const chartDays = useMemo<StackedDay[]>(() => {
    if (!isCumulative) return dailyDays
    const running: Record<string, number> = {}
    return dailyDays.map((d) => {
      const values: Record<string, number> = {}
      for (const s of series) {
        running[s.id] = (running[s.id] ?? 0) + (d.values[s.id] ?? 0)
        values[s.id] = running[s.id]
      }
      return { date: d.date, values }
    })
  }, [dailyDays, series, isCumulative])

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      <View className="flex-row items-center justify-between flex-wrap gap-2">
        <View className="flex-1 min-w-[140px]">
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
          <Text className="text-xs text-muted-foreground">{subtitle}</Text>
        </View>
        <View className="flex-row items-center gap-2 flex-wrap">
          {allowCumulative ? (
            <MetricToggle
              value={mode}
              onChange={setMode}
              options={[
                { id: 'daily', label: 'Daily' },
                { id: 'cumulative', label: 'Cumulative' },
              ]}
            />
          ) : null}
          <GroupBySelect value={groupBy} onChange={onGroupByChange} options={groupByOptions} />
          <MetricSelect value={metric} onChange={onMetricChange} />
        </View>
      </View>

      {showTotals && metric === 'spend' && data && (
        <View className="flex-row flex-wrap gap-2">
          <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
            <Text className="text-[10px] text-muted-foreground mb-0.5">Total {isLocalMode ? 'cost' : 'spend'}</Text>
            <Text className="text-base font-bold text-foreground">{chartUsd(data.totals.totalSpendUsd)}</Text>
          </View>
          <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
            <Text className="text-[10px] text-muted-foreground mb-0.5">Included</Text>
            <Text className="text-base font-bold text-foreground">{chartUsd(data.totals.totalIncludedUsd)}</Text>
          </View>
          <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
            <Text className="text-[10px] text-muted-foreground mb-0.5">On-demand</Text>
            <Text className="text-base font-bold text-foreground">{chartUsd(data.totals.totalOnDemandUsd)}</Text>
          </View>
        </View>
      )}

      {loading ? (
        <View style={{ height }} className="items-center justify-center"><ActivityIndicator /></View>
      ) : chartDays.length === 0 || series.length === 0 ? (
        <View style={{ height }} className="items-center justify-center">
          <Text className="text-sm text-muted-foreground">No usage data for this period</Text>
        </View>
      ) : (
        <StackedAreaChart
          days={chartDays}
          series={series}
          height={height}
          formatY={(n) =>
            metric === 'spend'
              ? chartUsd(n)
              : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n))
          }
          formatTooltip={(n) => (metric === 'spend' ? chartUsd(n) : n.toLocaleString())}
        />
      )}
    </View>
  )
}

// =============================================================================
// Generic single-metric trend chart (reused by activity / active-users / quality)
// =============================================================================

export interface TrendMetricOption {
  id: string
  label: string
  color?: string
  /** Format used for both the Y axis and the tooltip. */
  format?: (n: number) => string
}

export function MetricTrendChart({
  title,
  subtitle,
  loading,
  days,
  metrics,
  height = 240,
  allowCumulative = false,
  baselines,
}: {
  title: string
  subtitle?: string
  loading?: boolean
  days: StackedDay[]
  metrics: TrendMetricOption[]
  height?: number
  /** When true, show a Daily/Cumulative toggle that turns the series into a running total. */
  allowCumulative?: boolean
  /**
   * Starting value for the cumulative line per metric id (e.g. entities that
   * existed before the window). The cumulative series ends at
   * `baseline + sum(window)`, so it lines up with a "Total X" stat card.
   */
  baselines?: Record<string, number>
}) {
  const [selected, setSelected] = useState<string>(metrics[0]?.id ?? '')
  const [mode, setMode] = useState<'daily' | 'cumulative'>('daily')
  const metric = metrics.find((m) => m.id === selected) ?? metrics[0]
  const series: StackedSeries[] = metric
    ? [{ id: metric.id, label: metric.label, color: metric.color ?? STACKED_PALETTE[0] }]
    : []
  const fmt = metric?.format ?? ((n: number) => formatNumber(n))

  const isCumulative = allowCumulative && mode === 'cumulative'
  const chartDays = useMemo<StackedDay[]>(() => {
    if (!isCumulative || !metric) return days
    let running = baselines?.[metric.id] ?? 0
    return days.map((d) => {
      running += d.values[metric.id] ?? 0
      return { ...d, values: { ...d.values, [metric.id]: running } }
    })
  }, [days, isCumulative, metric, baselines])

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      <View className="flex-row items-center justify-between flex-wrap gap-2">
        <View className="flex-1 min-w-[140px]">
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
          {subtitle ? <Text className="text-xs text-muted-foreground">{subtitle}</Text> : null}
        </View>
        <View className="flex-row items-center gap-2 flex-wrap">
          {allowCumulative ? (
            <MetricToggle
              value={mode}
              onChange={setMode}
              options={[
                { id: 'daily', label: 'Daily' },
                { id: 'cumulative', label: 'Cumulative' },
              ]}
            />
          ) : null}
          <MetricToggle
            value={selected}
            onChange={setSelected}
            options={metrics.map((m) => ({ id: m.id, label: m.label }))}
          />
        </View>
      </View>

      {loading ? (
        <View style={{ height }} className="items-center justify-center"><ActivityIndicator /></View>
      ) : days.length === 0 ? (
        <View style={{ height }} className="items-center justify-center">
          <Text className="text-sm text-muted-foreground">No data for this period</Text>
        </View>
      ) : (
        <StackedAreaChart
          days={chartDays}
          series={series}
          height={height}
          formatY={fmt}
          formatTooltip={fmt}
        />
      )}
    </View>
  )
}

// =============================================================================
// Activity trends (new users / messages / projects per day)
// =============================================================================

export interface ActivityTimeseriesPoint {
  date: string
  newUsers: number
  newWorkspaces: number
  newProjects: number
  messages: number
  sessions: number
  toolCalls: number
  activePayingSubscribers: number
}

const PCT = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}%`

export function ActivityTrendsChart({
  data,
  loading,
  title = 'Activity Trends',
}: {
  data: ActivityTimeseriesPoint[] | null
  loading?: boolean
  title?: string
}) {
  const days: StackedDay[] = (data ?? []).map((d) => ({
    date: d.date,
    values: {
      newUsers: d.newUsers,
      messages: d.messages,
      newProjects: d.newProjects,
      sessions: d.sessions,
      toolCalls: d.toolCalls,
      newWorkspaces: d.newWorkspaces,
      activePayingSubscribers: d.activePayingSubscribers,
    },
  }))
  const metrics: TrendMetricOption[] = [
    { id: 'newUsers', label: 'New users', color: STACKED_PALETTE[1], format: formatNumber },
    { id: 'activePayingSubscribers', label: 'Paid Users', color: STACKED_PALETTE[7], format: formatNumber },
    { id: 'messages', label: 'Messages', color: STACKED_PALETTE[0], format: formatNumber },
    { id: 'newProjects', label: 'Projects', color: STACKED_PALETTE[2], format: formatNumber },
    { id: 'sessions', label: 'Sessions', color: STACKED_PALETTE[3], format: formatNumber },
    { id: 'toolCalls', label: 'Tool calls', color: STACKED_PALETTE[5], format: formatNumber },
    { id: 'newWorkspaces', label: 'Workspaces', color: STACKED_PALETTE[4], format: formatNumber },
  ]
  return (
    <MetricTrendChart
      title={title}
      subtitle="Daily new entities and engagement"
      loading={loading}
      days={days}
      metrics={metrics}
    />
  )
}

// =============================================================================
// Platform growth (users / workspaces / projects / sessions over time)
// =============================================================================

export interface PlatformGrowthPoint {
  date: string
  users: number
  workspaces: number
  projects: number
  sessions: number
}

/** Current platform totals, used to anchor the cumulative line to the cards. */
export interface PlatformGrowthTotals {
  totalUsers?: number
  totalWorkspaces?: number
  totalProjects?: number
  totalChatSessions?: number
}

/**
 * Core-entity growth chart with a Daily/Cumulative toggle. Daily mode shows new
 * entities per day; cumulative mode shows a running total that ends at the
 * matching "Total X" stat card (baseline = current total minus what was created
 * inside the window).
 */
export function PlatformGrowthChart({
  data,
  totals,
  loading,
  title = 'Growth',
}: {
  data: PlatformGrowthPoint[] | null
  totals?: PlatformGrowthTotals | null
  loading?: boolean
  title?: string
}) {
  const rows = data ?? []
  const days: StackedDay[] = rows.map((d) => ({
    date: d.date,
    values: {
      users: d.users ?? 0,
      workspaces: d.workspaces ?? 0,
      projects: d.projects ?? 0,
      sessions: d.sessions ?? 0,
    },
  }))
  const sum = (key: 'users' | 'workspaces' | 'projects' | 'sessions') =>
    rows.reduce((acc, d) => acc + (d[key] ?? 0), 0)
  const baseline = (total: number | undefined, windowSum: number) =>
    Math.max((total ?? windowSum) - windowSum, 0)
  const baselines: Record<string, number> = {
    users: baseline(totals?.totalUsers, sum('users')),
    workspaces: baseline(totals?.totalWorkspaces, sum('workspaces')),
    projects: baseline(totals?.totalProjects, sum('projects')),
    sessions: baseline(totals?.totalChatSessions, sum('sessions')),
  }
  const metrics: TrendMetricOption[] = [
    { id: 'users', label: 'Users', color: STACKED_PALETTE[1], format: formatNumber },
    { id: 'workspaces', label: 'Workspaces', color: STACKED_PALETTE[3], format: formatNumber },
    { id: 'projects', label: 'Projects', color: STACKED_PALETTE[2], format: formatNumber },
    { id: 'sessions', label: 'Sessions', color: STACKED_PALETTE[0], format: formatNumber },
  ]
  return (
    <MetricTrendChart
      title={title}
      subtitle="New per day, or cumulative running total"
      loading={loading}
      days={days}
      metrics={metrics}
      allowCumulative
      baselines={baselines}
    />
  )
}

// =============================================================================
// Active users trend (DAU / WAU / MAU over time)
// =============================================================================

export interface ActiveUsersTimeseriesPoint {
  date: string
  dau: number
  wau: number
  mau: number
}

export function ActiveUsersTrendChart({
  data,
  loading,
}: {
  data: ActiveUsersTimeseriesPoint[] | null
  loading?: boolean
}) {
  const days: StackedDay[] = (data ?? []).map((d) => ({
    date: d.date,
    values: { dau: d.dau, wau: d.wau, mau: d.mau },
  }))
  const metrics: TrendMetricOption[] = [
    { id: 'dau', label: 'Daily', color: STACKED_PALETTE[1], format: formatNumber },
    { id: 'wau', label: 'Weekly', color: STACKED_PALETTE[0], format: formatNumber },
    { id: 'mau', label: 'Monthly', color: STACKED_PALETTE[3], format: formatNumber },
  ]
  return (
    <MetricTrendChart
      title="Active Users"
      subtitle="Rolling DAU / WAU / MAU over time"
      loading={loading}
      days={days}
      metrics={metrics}
    />
  )
}

// =============================================================================
// Quality & efficiency trend (cache hit, unit economics, agent quality)
// =============================================================================

export interface QualityTimeseriesPoint {
  date: string
  cacheHitRatio: number
  costPerMessage: number
  costPerActiveUser: number
  agentEscalatedRate: number
  agentLoopRate: number
  agentMaxTurnsRate: number
}

export function QualityTimeseriesChart({
  data,
  loading,
}: {
  data: QualityTimeseriesPoint[] | null
  loading?: boolean
}) {
  const days: StackedDay[] = (data ?? []).map((d) => ({
    date: d.date,
    values: {
      cacheHitRatio: d.cacheHitRatio,
      costPerMessage: d.costPerMessage,
      costPerActiveUser: d.costPerActiveUser,
      agentEscalatedRate: d.agentEscalatedRate,
      agentLoopRate: d.agentLoopRate,
      agentMaxTurnsRate: d.agentMaxTurnsRate,
    },
  }))
  const metrics: TrendMetricOption[] = [
    { id: 'cacheHitRatio', label: 'Cache hit', color: STACKED_PALETTE[0], format: PCT },
    { id: 'costPerMessage', label: '$/msg', color: STACKED_PALETTE[2], format: formatDollarCost },
    { id: 'costPerActiveUser', label: '$/active user', color: STACKED_PALETTE[1], format: formatDollarCost },
    { id: 'agentEscalatedRate', label: 'Escalated', color: STACKED_PALETTE[5], format: PCT },
    { id: 'agentLoopRate', label: 'Loop', color: STACKED_PALETTE[6], format: PCT },
    { id: 'agentMaxTurnsRate', label: 'Max turns', color: STACKED_PALETTE[7], format: PCT },
  ]
  return (
    <MetricTrendChart
      title="Quality & Efficiency"
      subtitle="Daily cache hit ratio, unit economics, and agent quality"
      loading={loading}
      days={days}
      metrics={metrics}
    />
  )
}

// =============================================================================
// Tool Call Analytics
// =============================================================================

export interface ToolCallStat {
  toolName: string
  total: number
  errors: number
  successRate: number
  avgDurationMs: number
}

export interface ToolCallAnalyticsData {
  tools: ToolCallStat[]
  totals: {
    totalCalls: number
    totalErrors: number
    successRate: number
  }
  daily: { date: string; calls: number; errors: number; successRate: number }[]
}

export function ToolCallAnalyticsPanel({
  data,
  loading,
}: {
  data: ToolCallAnalyticsData | null
  loading?: boolean
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || !data.tools?.length) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Tool Calls</Text>
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No tool calls for this period</Text>
        </View>
      </View>
    )
  }

  const maxCalls = Math.max(...data.tools.map((t) => t.total), 1)
  const days: StackedDay[] = (data.daily ?? []).map((d) => ({
    date: d.date,
    values: { successRate: d.successRate, calls: d.calls, errors: d.errors },
  }))
  const trendMetrics: TrendMetricOption[] = [
    { id: 'successRate', label: 'Success %', color: STACKED_PALETTE[0], format: PCT },
    { id: 'calls', label: 'Calls', color: STACKED_PALETTE[1], format: formatNumber },
    { id: 'errors', label: 'Errors', color: STACKED_PALETTE[6], format: formatNumber },
  ]

  const successColor = (rate: number) =>
    rate >= 95 ? 'text-emerald-500' : rate >= 80 ? 'text-yellow-500' : 'text-red-500'
  const barColor = (rate: number) =>
    rate >= 95 ? 'bg-emerald-500' : rate >= 80 ? 'bg-yellow-500' : 'bg-red-500'

  return (
    <View className="gap-4">
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Tool Calls</Text>

        {/* Totals */}
        <View className="flex-row flex-wrap gap-2 mb-4">
          <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
            <Text className="text-[10px] text-muted-foreground mb-0.5">Total calls</Text>
            <Text className="text-base font-bold text-foreground">{formatNumber(data.totals.totalCalls)}</Text>
          </View>
          <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
            <Text className="text-[10px] text-muted-foreground mb-0.5">Errors</Text>
            <Text className="text-base font-bold text-foreground">{formatNumber(data.totals.totalErrors)}</Text>
          </View>
          <View className="flex-1 min-w-[100px] p-2 rounded-lg bg-muted/40 border border-border/50">
            <Text className="text-[10px] text-muted-foreground mb-0.5">Success rate</Text>
            <Text className={cn('text-base font-bold', successColor(data.totals.successRate))}>
              {data.totals.successRate.toFixed(1)}%
            </Text>
          </View>
        </View>

        {/* Header */}
        <View className="flex-row items-center py-1.5 border-b border-border">
          <Text className="flex-1 text-[10px] font-medium text-muted-foreground">Tool</Text>
          <Text className="w-16 text-[10px] font-medium text-muted-foreground text-right">Calls</Text>
          <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Errors</Text>
          <Text className="w-24 text-[10px] font-medium text-muted-foreground text-right">Success</Text>
          <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Avg</Text>
        </View>

        {/* Rows */}
        {data.tools.map((t) => (
          <View key={t.toolName} className="flex-row items-center py-2 border-b border-border/50">
            <View className="flex-1 pr-2">
              <Text className="text-xs font-medium text-foreground" numberOfLines={1}>{t.toolName}</Text>
              <View className="h-1.5 mt-1 bg-muted rounded-full overflow-hidden">
                <View className="h-full rounded-full bg-primary/60" style={{ width: `${Math.max((t.total / maxCalls) * 100, 3)}%` }} />
              </View>
            </View>
            <Text className="w-16 text-right text-[11px] font-mono text-foreground">{formatNumber(t.total)}</Text>
            <Text className="w-14 text-right text-[11px] font-mono text-muted-foreground">{formatNumber(t.errors)}</Text>
            <View className="w-24 flex-row items-center justify-end gap-1.5">
              <View className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[48px]">
                <View className={cn('h-full rounded-full', barColor(t.successRate))} style={{ width: `${t.successRate}%` }} />
              </View>
              <Text className={cn('text-[11px] font-mono', successColor(t.successRate))}>{t.successRate.toFixed(0)}%</Text>
            </View>
            <Text className="w-14 text-right text-[10px] text-muted-foreground">{formatDuration(t.avgDurationMs)}</Text>
          </View>
        ))}
      </View>

      <MetricTrendChart
        title="Tool Call Trend"
        subtitle="Daily success rate and volume"
        days={days}
        metrics={trendMetrics}
        height={200}
      />
    </View>
  )
}

// =============================================================================
// Workspace Activity Table
// =============================================================================

export interface WorkspaceActivityEntry {
  workspaceId: string
  name: string
  projects: number
  members: number
  messages: number
  toolCalls: number
  spendUsd: number
}

export interface WorkspaceActivityData {
  workspaces: WorkspaceActivityEntry[]
  total: number
  page?: number
  limit?: number
}

export function WorkspaceActivityTable({
  data,
  loading,
  page = 1,
  onPageChange,
}: {
  data: WorkspaceActivityData | null
  loading: boolean
  page?: number
  onPageChange?: (page: number) => void
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-28 bg-muted rounded mb-3" />
        <View className="h-40 bg-muted/50 rounded" />
      </View>
    )
  }

  if (!data || !data.workspaces?.length) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Workspace Activity</Text>
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No workspace data</Text>
        </View>
      </View>
    )
  }

  const totalPages = data.limit != null ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-sm font-semibold text-foreground">Workspace Activity</Text>
        <Text className="text-[10px] text-muted-foreground">{data.total} workspaces</Text>
      </View>

      {/* Header */}
      <View className="flex-row items-center py-1.5 border-b border-border">
        <Text className="flex-[2] text-[10px] font-medium text-muted-foreground">Workspace</Text>
        <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Projects</Text>
        <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Members</Text>
        <Text className="w-14 text-[10px] font-medium text-muted-foreground text-right">Msgs</Text>
        <Text className="w-16 text-[10px] font-medium text-muted-foreground text-right">Spend</Text>
      </View>

      {/* Rows */}
      {data.workspaces.map((w) => (
        <View key={w.workspaceId} className="flex-row items-center py-2 border-b border-border/50">
          <Text className="flex-[2] text-xs font-medium text-foreground" numberOfLines={1}>{w.name || '—'}</Text>
          <Text className="w-14 text-xs text-foreground text-right">{w.projects}</Text>
          <Text className="w-14 text-xs text-foreground text-right">{w.members}</Text>
          <Text className="w-14 text-xs text-foreground text-right">{formatNumber(w.messages)}</Text>
          <Text className="w-16 text-xs text-foreground text-right">{formatDollarCost(w.spendUsd)}</Text>
        </View>
      ))}

      {/* Pagination */}
      {onPageChange && data.limit != null && data.total > data.limit && (
        <View className="flex-row items-center justify-center gap-4 mt-3">
          <Pressable onPress={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>
            <ChevronLeft size={16} className={page <= 1 ? 'text-muted' : 'text-foreground'} />
          </Pressable>
          <Text className="text-xs text-muted-foreground">Page {page} of {totalPages}</Text>
          <Pressable onPress={() => onPageChange(page + 1)} disabled={page >= totalPages}>
            <ChevronRight size={16} className={page >= totalPages ? 'text-muted' : 'text-foreground'} />
          </Pressable>
        </View>
      )}
    </View>
  )
}
