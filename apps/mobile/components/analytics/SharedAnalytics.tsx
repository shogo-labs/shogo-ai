// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Analytics Components
 *
 * Reusable analytics UI components used by the admin dashboard,
 * workspace settings analytics tab, and user profile usage section.
 */

import { useState, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Image,
  Platform,
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
  LayoutTemplate,
  RefreshCw,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  getModelShortDisplayName,
  getModelFamily,
  type ModelFamily,
} from '@shogo/model-catalog'

// =============================================================================
// Types
// =============================================================================

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '1y'

export const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
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
  totalCredits: number
  avgDurationMs: number
}

export interface UsageSummaryData {
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
  creditCost: number
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
  totalCreditsConsumed: number
  actionBreakdown: Array<{ action: string; _count: number }>
  topConsumers?: Array<{ workspaceId: string; _sum: { creditsUsed: number | null } }>
}

// =============================================================================
// Formatters
// =============================================================================

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
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
  return FAMILY_BG_COLOR[getModelFamily(model)] ?? 'bg-muted border-border'
}

export function getModelTextColor(model: string): string {
  return FAMILY_TEXT_COLOR[getModelFamily(model)] ?? 'text-muted-foreground'
}

export const getModelDisplayName = getModelShortDisplayName

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
  return (
    <View className="flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {(Object.keys(PERIOD_LABELS) as AnalyticsPeriod[]).map((period) => {
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

export function UsageSummaryView({ data }: { data: UsageSummaryData }) {
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
                {entry.requestCount.toLocaleString()}
              </Text>
              <Text className="w-16 text-right text-[10px] font-mono text-foreground">
                {formatNumber(entry.totalTokens)}
              </Text>
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

export function UsageEventLogView({
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
        Showing {(data.entries ?? []).length} of {data.total.toLocaleString()} events
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

export function UsageTableSection({
  summaryData,
  logData,
  summaryLoading,
  logLoading,
  onLogPageChange,
  logPage,
  title,
}: {
  summaryData: UsageSummaryData | null
  logData: UsageLogData | null
  summaryLoading: boolean
  logLoading: boolean
  onLogPageChange: (p: number) => void
  logPage: number
  title?: string
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
  creditsUsed: number
}

export interface UserActivityData {
  users: UserActivityEntry[]
  total: number
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
        <Text className="w-16 text-[10px] font-medium text-muted-foreground text-right">Credits</Text>
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
          <Text className="w-16 text-xs text-foreground text-right">{u.creditsUsed.toFixed(1)}</Text>
        </View>
      ))}

      {/* Pagination */}
      {onPageChange && data.total > 20 && (
        <View className="flex-row items-center justify-center gap-4 mt-3">
          <Pressable onPress={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>
            <ChevronLeft size={16} className={page <= 1 ? 'text-muted' : 'text-foreground'} />
          </Pressable>
          <Text className="text-xs text-muted-foreground">Page {page}</Text>
          <Pressable
            onPress={() => onPageChange(page + 1)}
            disabled={page * 20 >= data.total}
          >
            <ChevronRight size={16} className={page * 20 >= data.total ? 'text-muted' : 'text-foreground'} />
          </Pressable>
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Template Engagement Panel
// =============================================================================

export interface TemplateStatsEntry {
  templateId: string
  projects: number
  avgMessages: number
  totalToolCalls: number
  engagementRate: number
}

export interface TemplateEngagementData {
  templates: TemplateStatsEntry[]
}

export function TemplateEngagementPanel({
  data,
  loading,
}: {
  data: TemplateEngagementData | null
  loading: boolean
}) {
  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <View className="h-4 w-36 bg-muted rounded mb-3" />
        <View className="gap-2">
          {[1, 2, 3].map(i => <View key={i} className="h-14 bg-muted/50 rounded-lg" />)}
        </View>
      </View>
    )
  }

  if (!data || data.templates.length === 0) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground mb-3">Template Engagement</Text>
        <View className="py-4 items-center">
          <Text className="text-sm text-muted-foreground">No template data</Text>
        </View>
      </View>
    )
  }

  const sorted = [...data.templates].sort((a, b) => b.engagementRate - a.engagementRate)

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-2 mb-3">
        <LayoutTemplate size={14} className="text-muted-foreground" />
        <Text className="text-sm font-semibold text-foreground">Template Engagement</Text>
      </View>
      <View className="gap-2">
        {sorted.map(t => (
          <View key={t.templateId} className="flex-row items-center p-2 rounded-lg bg-muted/50 gap-3">
            <View className="flex-1">
              <Text className="text-xs font-medium text-foreground" numberOfLines={1}>{t.templateId}</Text>
              <Text className="text-[10px] text-muted-foreground">
                {t.projects} projects · {t.avgMessages.toFixed(1)} avg msgs · {t.totalToolCalls} tools
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-sm font-bold text-foreground">{t.engagementRate}%</Text>
              <Text className="text-[10px] text-muted-foreground">engaged</Text>
            </View>
          </View>
        ))}
      </View>
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
