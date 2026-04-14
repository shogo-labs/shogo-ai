// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import {
  BarChart3,
  TrendingUp,
  Zap,
  MessageSquare,
  Wrench,
  Clock,
  RefreshCw,
  AlertTriangle,
  DollarSign,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { api } from '../../../lib/api'
import type { HttpClient } from '@shogo-ai/sdk'

type Period = '7d' | '30d' | '90d'
type DailyCount = { date: string; count: number }

interface OverviewData {
  chatSessions: number
  usageEvents: number
  messages: number
}

interface UsageData {
  totalEvents: number
  totalCreditsConsumed: number
  byActionType: Record<string, { count: number; totalCredits: number }>
  dailyUsage: Array<{ date: string; count: number }>
}

interface ChatData {
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  avgMessagesPerSession: number
  dailySessions: Array<{ date: string; count: number }>
}

interface DailyActivityPoint {
  date: string
  usageEvents: number
  sessions: number
  total: number
}

const PERIOD_DAY_COUNTS: Record<Period, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

const DAILY_ACTIVITY_CHART_HEIGHT = 88
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SKELETON_BAR_HEIGHTS = [18, 34, 26, 52, 40, 64, 28, 46, 58, 32, 72, 42]

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function sumByDate(points: DailyCount[] = []): Map<string, number> {
  const counts = new Map<string, number>()

  for (const point of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue
    const count = Number.isFinite(point.count) ? Math.max(0, point.count) : 0
    counts.set(point.date, (counts.get(point.date) ?? 0) + count)
  }

  return counts
}

function buildDailyActivitySeries(
  period: Period,
  usageEvents: DailyCount[] = [],
  sessions: DailyCount[] = [],
): DailyActivityPoint[] {
  const dayCount = PERIOD_DAY_COUNTS[period]
  const usageByDate = sumByDate(usageEvents)
  const sessionsByDate = sumByDate(sessions)
  const end = startOfUtcDay(new Date())
  const start = addUtcDays(end, -(dayCount - 1))

  return Array.from({ length: dayCount }, (_, index) => {
    const date = toUtcDateKey(addUtcDays(start, index))
    const usageCount = usageByDate.get(date) ?? 0
    const sessionCount = sessionsByDate.get(date) ?? 0

    return {
      date,
      usageEvents: usageCount,
      sessions: sessionCount,
      total: usageCount + sessionCount,
    }
  })
}

function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  if (!year || !month || !day) return dateKey

  return `${MONTH_LABELS[month - 1] ?? ''} ${day}`
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

function getLatestActiveDay(series: DailyActivityPoint[]): DailyActivityPoint | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].total > 0) return series[index]
  }
  return null
}

function formatSelectedActivity(point: DailyActivityPoint): string {
  if (point.total === 0) return 'No activity'

  const parts = [
    point.usageEvents > 0 ? pluralize(point.usageEvents, 'usage event') : null,
    point.sessions > 0 ? pluralize(point.sessions, 'session') : null,
  ].filter(Boolean)

  return parts.join(' + ')
}

function useProjectAnalytics<T>(
  http: HttpClient,
  projectId: string,
  endpoint: string,
  period: Period,
  visible: boolean,
) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.getProjectAnalytics<T>(http, projectId, endpoint, period)
      setData(result)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [http, projectId, endpoint, period])

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  return { data, loading, error, reload: load }
}

interface AnalyticsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function AnalyticsPanel({ projectId, agentUrl, visible }: AnalyticsPanelProps) {
  const http = useDomainHttp()
  const [period, setPeriod] = useState<Period>('7d')
  const [selectedActivityDate, setSelectedActivityDate] = useState<string | null>(null)

  const overview = useProjectAnalytics<OverviewData>(http, projectId, 'overview', period, visible)
  const usage = useProjectAnalytics<UsageData>(http, projectId, 'usage', period, visible)
  const chat = useProjectAnalytics<ChatData>(http, projectId, 'chat', period, visible)
  const dailyActivity = useMemo(
    () => buildDailyActivitySeries(period, usage.data?.dailyUsage, chat.data?.dailySessions),
    [period, usage.data?.dailyUsage, chat.data?.dailySessions],
  )

  const handleRefresh = () => {
    overview.reload()
    usage.reload()
    chat.reload()
  }

  const isLoading = overview.loading || usage.loading || chat.loading
  const hasError = overview.error || usage.error || chat.error

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Header */}
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <BarChart3 size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Analytics</Text>

        <View className="ml-auto flex-row items-center gap-2">
          <View className="flex-row rounded-md border border-border">
            {(['7d', '30d', '90d'] as Period[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => {
                  setPeriod(p)
                  setSelectedActivityDate(null)
                }}
                className={cn('px-2 py-1', period === p ? 'bg-primary' : 'active:bg-muted')}
              >
                <Text className={cn('text-xs', period === p ? 'text-primary-foreground' : 'text-muted-foreground')}>
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={handleRefresh} className="p-1 rounded-md active:bg-muted">
            <RefreshCw size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {hasError && (
        <View className="px-4 py-2 bg-destructive/10 flex-row items-center gap-1">
          <AlertTriangle size={12} className="text-destructive" />
          <Text className="text-xs text-destructive">{overview.error || usage.error || chat.error}</Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        <View className="gap-4">
          {/* Overview stat cards */}
          <View className="flex-row flex-wrap gap-3">
            <StatCard
              icon={<MessageSquare size={16} className="text-muted-foreground" />}
              label="Messages"
              value={overview.data?.messages}
              loading={overview.loading}
            />
            <StatCard
              icon={<Zap size={16} className="text-muted-foreground" />}
              label="Usage Events"
              value={overview.data?.usageEvents}
              loading={overview.loading}
            />
            <StatCard
              icon={<Wrench size={16} className="text-muted-foreground" />}
              label="Tool Calls"
              value={chat.data?.totalToolCalls}
              loading={chat.loading}
            />
            <StatCard
              icon={<Clock size={16} className="text-muted-foreground" />}
              label="Sessions"
              value={chat.data?.totalSessions}
              loading={chat.loading}
            />
          </View>

          {/* Credit usage */}
          {usage.data && (
            <View className="border border-border rounded-lg p-3 gap-2">
              <View className="flex-row items-center gap-2">
                <DollarSign size={14} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-foreground">Credit Usage</Text>
              </View>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-2xl font-bold text-foreground">{usage.data.totalCreditsConsumed.toFixed(1)}</Text>
                <Text className="text-xs text-muted-foreground">credits consumed</Text>
              </View>
              <Text className="text-xs text-muted-foreground">{usage.data.totalEvents} total events</Text>
            </View>
          )}

          {/* Chat stats */}
          {chat.data && chat.data.totalMessages > 0 && (
            <View className="border border-border rounded-lg p-3 gap-2">
              <View className="flex-row items-center gap-2">
                <TrendingUp size={14} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-foreground">Conversation Stats</Text>
              </View>
              <View className="flex-row gap-8">
                <View>
                  <Text className="text-xs text-muted-foreground">Avg msgs/session</Text>
                  <Text className="text-sm font-medium text-foreground">{chat.data.avgMessagesPerSession}</Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Tool call rate</Text>
                  <Text className="text-sm font-medium text-foreground">
                    {chat.data.totalMessages > 0
                      ? ((chat.data.totalToolCalls / chat.data.totalMessages) * 100).toFixed(0)
                      : 0}
                    %
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* Usage by action type */}
          {usage.data && Object.keys(usage.data.byActionType).length > 0 && (
            <View className="border border-border rounded-lg p-3 gap-2">
              <Text className="text-xs font-medium text-foreground">Usage by Type</Text>
              <View className="gap-1.5">
                {Object.entries(usage.data.byActionType)
                  .sort(([, a], [, b]) => b.count - a.count)
                  .map(([type, d]) => {
                    const maxCount = Math.max(...Object.values(usage.data!.byActionType).map((v) => v.count))
                    return (
                      <View key={type}>
                        <View className="flex-row justify-between mb-0.5">
                          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                            {type.replace(/_/g, ' ')}
                          </Text>
                          <Text className="text-xs font-medium text-foreground ml-2">{d.count}</Text>
                        </View>
                        <View className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <View
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${(d.count / maxCount) * 100}%` }}
                          />
                        </View>
                      </View>
                    )
                  })}
              </View>
            </View>
          )}

          <DailyActivityChart
            series={dailyActivity}
            loading={usage.loading || chat.loading}
            selectedDate={selectedActivityDate}
            onSelectDate={setSelectedActivityDate}
          />

          {/* Empty state */}
          {!isLoading && !hasError && overview.data?.messages === 0 && (
            <View className="items-center py-8">
              <BarChart3 size={32} className="text-muted-foreground mb-2" />
              <Text className="text-sm text-muted-foreground">No activity yet</Text>
              <Text className="text-xs text-muted-foreground mt-1">
                Analytics will appear once the agent starts processing messages.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

function DailyActivityChart({
  series,
  loading,
  selectedDate,
  onSelectDate,
}: {
  series: DailyActivityPoint[]
  loading: boolean
  selectedDate: string | null
  onSelectDate: (date: string) => void
}) {
  const hasActivity = series.some((point) => point.total > 0)
  const maxTotal = Math.max(...series.map((point) => point.total), 1)
  const usageEventTotal = series.reduce((sum, point) => sum + point.usageEvents, 0)
  const sessionTotal = series.reduce((sum, point) => sum + point.sessions, 0)
  const activeDays = series.filter((point) => point.total > 0).length
  const peakPoint = series.reduce<DailyActivityPoint | null>(
    (peak, point) => (!peak || point.total > peak.total ? point : peak),
    null,
  )
  const selectedPoint =
    (selectedDate ? series.find((point) => point.date === selectedDate) : null) ??
    getLatestActiveDay(series) ??
    series[series.length - 1] ??
    null
  const rangeLabel =
    series.length > 0 ? `${formatDateLabel(series[0].date)} - ${formatDateLabel(series[series.length - 1].date)}` : ''
  const barMaxWidth = series.length <= 7 ? 18 : series.length <= 30 ? 10 : 5

  return (
    <View className="border border-border rounded-lg p-3 gap-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-xs font-medium text-foreground">Daily Activity</Text>
          <Text className="text-[10px] text-muted-foreground">Usage events and sessions, {rangeLabel}</Text>
        </View>
        {loading && <ActivityIndicator size="small" />}
      </View>

      <View className="flex-row flex-wrap gap-2">
        <ActivitySummaryPill label="Usage events" value={usageEventTotal} />
        <ActivitySummaryPill label="Sessions" value={sessionTotal} />
        <ActivitySummaryPill label="Active days" value={`${activeDays}/${series.length}`} />
        <ActivitySummaryPill
          label="Peak"
          value={peakPoint && peakPoint.total > 0 ? `${peakPoint.total} on ${formatDateLabel(peakPoint.date)}` : 0}
        />
      </View>

      <View className="rounded-lg border border-border/60 bg-muted/10 p-3">
        {loading && !hasActivity ? (
          <View className="flex-row items-end gap-1" style={{ height: DAILY_ACTIVITY_CHART_HEIGHT }}>
            {SKELETON_BAR_HEIGHTS.map((height, index) => (
              <View key={index} className="flex-1 items-center justify-end">
                <View className="w-2 rounded-t-sm bg-muted/70" style={{ height }} />
              </View>
            ))}
          </View>
        ) : !hasActivity ? (
          <View className="items-center justify-center gap-1" style={{ height: DAILY_ACTIVITY_CHART_HEIGHT }}>
            <Text className="text-sm font-medium text-muted-foreground">No activity in this period</Text>
            <Text className="text-[10px] text-muted-foreground">Send a message or try a wider range.</Text>
          </View>
        ) : (
          <View>
            <View className="relative overflow-hidden" style={{ height: DAILY_ACTIVITY_CHART_HEIGHT }}>
              <View pointerEvents="none" className="absolute left-0 right-0 top-0 h-px bg-border/40" />
              <View
                pointerEvents="none"
                className="absolute left-0 right-0 h-px bg-border/30"
                style={{ top: DAILY_ACTIVITY_CHART_HEIGHT / 2 }}
              />
              <View pointerEvents="none" className="absolute bottom-0 left-0 right-0 h-px bg-border/40" />

              <View className="flex-row items-end gap-px" style={{ height: DAILY_ACTIVITY_CHART_HEIGHT }}>
                {series.map((point) => {
                  const isSelected = selectedPoint?.date === point.date
                  const barHeight =
                    point.total > 0 ? Math.max((point.total / maxTotal) * DAILY_ACTIVITY_CHART_HEIGHT, 4) : 2

                  return (
                    <Pressable
                      key={point.date}
                      accessibilityRole="button"
                      accessibilityLabel={`${formatDateLabel(point.date)}: ${formatSelectedActivity(point)}`}
                      onPress={() => onSelectDate(point.date)}
                      className="flex-1 items-center justify-end rounded-sm active:opacity-80"
                      style={{ height: DAILY_ACTIVITY_CHART_HEIGHT }}
                    >
                      <View
                        className={cn(
                          'rounded-t-sm',
                          point.total === 0 && 'bg-muted/60',
                          point.total > 0 && point.usageEvents === 0 && 'bg-emerald-500/70',
                          point.total > 0 && point.usageEvents > 0 && 'bg-primary/70',
                          isSelected && point.total > 0 && 'bg-primary',
                        )}
                        style={{
                          height: barHeight,
                          width: '70%',
                          minWidth: 2,
                          maxWidth: barMaxWidth,
                        }}
                      />
                    </Pressable>
                  )
                })}
              </View>
            </View>

            <View className="flex-row items-center justify-between mt-2">
              <Text className="text-[10px] text-muted-foreground">{formatDateLabel(series[0].date)}</Text>
              <Text className="text-[10px] text-muted-foreground">
                {formatDateLabel(series[series.length - 1].date)}
              </Text>
            </View>
          </View>
        )}
      </View>

      <View className="flex-row items-center gap-3">
        <View className="flex-row items-center gap-1.5">
          <View className="h-2 w-2 rounded-full bg-primary" />
          <Text className="text-[10px] text-muted-foreground">Usage events</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <View className="h-2 w-2 rounded-full bg-emerald-500" />
          <Text className="text-[10px] text-muted-foreground">Sessions only</Text>
        </View>
      </View>

      {selectedPoint && hasActivity && (
        <View className="flex-row items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
          <Text className="text-xs font-medium text-foreground">{formatDateLabel(selectedPoint.date)}</Text>
          <Text className="flex-1 text-right text-xs text-muted-foreground" numberOfLines={1}>
            {formatSelectedActivity(selectedPoint)}
          </Text>
        </View>
      )}
    </View>
  )
}

function ActivitySummaryPill({ label, value }: { label: string; value: number | string }) {
  return (
    <View className="rounded-md bg-muted/30 px-2.5 py-2">
      <Text className="text-[10px] text-muted-foreground">{label}</Text>
      <Text className="text-xs font-semibold text-foreground">{value}</Text>
    </View>
  )
}

function StatCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode
  label: string
  value?: number
  loading: boolean
}) {
  return (
    <View className="border border-border rounded-lg p-3 flex-1 min-w-[140px]">
      <View className="flex-row items-center gap-1.5 mb-1">
        {icon}
        <Text className="text-xs text-muted-foreground">{label}</Text>
      </View>
      <Text className="text-xl font-bold text-foreground">{loading ? '...' : (value?.toLocaleString() ?? 0)}</Text>
    </View>
  )
}
