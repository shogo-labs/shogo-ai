// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UsageDashboard
 *
 * Z Code-style usage stats plus what the person actually got done. One
 * component serves three places:
 *   - Profile: `{ kind: 'me' }`, a person's own numbers across workspaces
 *   - Settings > Usage: `{ kind: 'workspace', workspaceId }`, the whole team
 *   - Member drill-in: `{ kind: 'workspace', workspaceId, userId }`
 *
 * Authorization is enforced by the API (`/me/analytics/engagement`,
 * `/workspaces/:id/analytics/engagement`); this component only renders.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Code2,
  Coins,
  Flame,
  FolderOpen,
  MessageSquare,
  ShieldCheck,
  Trophy,
  Video,
  Wrench,
  Zap,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { useIsNativePhoneLayout } from '../../lib/native-phone-layout'
import { nativeActivePill } from '../../lib/native-active-shadow'
import {
  ENGAGEMENT_PERIODS,
  compactNumber,
  deviceTimezone,
  formatHourLabel,
  pluralDays,
  seriesColor,
  type EngagementPeriod,
  type EngagementStats,
  type RecentWorkItem,
} from '../../lib/engagement-utils'
import { Text } from '../settings/account-sheet-chrome'
import { StatCard, formatDollarCost } from './SharedAnalytics'
import { STACKED_PALETTE, StackedAreaChart } from './StackedAreaChart'
import { ActivityHeatmap, HourOfWeekGrid } from './ActivityHeatmap'
import { ModelShareDonut } from './ModelShareDonut'

export type DashboardSource =
  | { kind: 'me' }
  | { kind: 'workspace'; workspaceId: string; userId?: string }

// ============================================================================
// Data
// ============================================================================

function useEngagement(source: DashboardSource, period: EngagementPeriod) {
  const http = useDomainHttp()
  const [state, setState] = useState<{ data: EngagementStats | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  })
  const [reloadKey, setReloadKey] = useState(0)
  const latest = useRef(0)

  const sourceKey =
    source.kind === 'me' ? 'me' : `${source.workspaceId}:${source.userId ?? ''}`

  useEffect(() => {
    const requestId = ++latest.current
    setState((s) => ({ ...s, loading: true, error: null }))
    const params: Record<string, string> = { period, tz: deviceTimezone() }

    const request =
      source.kind === 'me'
        ? api.getMyAnalytics<EngagementStats>(http, 'engagement', params)
        : api.getWorkspaceAnalytics<EngagementStats>(http, source.workspaceId, 'engagement', {
            ...params,
            ...(source.userId ? { userId: source.userId } : {}),
          })

    request
      .then((data) => {
        if (requestId === latest.current) setState({ data, loading: false, error: null })
      })
      .catch((err: any) => {
        // A stale response must not overwrite a newer one (fast period switching).
        if (requestId === latest.current) {
          setState({ data: null, loading: false, error: err?.message || 'Could not load activity' })
        }
      })
    // `source` is represented by `sourceKey`; period and reloadKey trigger refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [http, sourceKey, period, reloadKey])

  return { ...state, reload: () => setReloadKey((k) => k + 1) }
}

// ============================================================================
// Small pieces
// ============================================================================

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      <View>
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
        {subtitle ? <Text className="text-xs text-muted-foreground">{subtitle}</Text> : null}
      </View>
      {children}
    </View>
  )
}

export function RangeSwitch({
  value,
  onChange,
}: {
  value: EngagementPeriod
  onChange: (p: EngagementPeriod) => void
}) {
  return (
    <View className="flex-row items-center bg-muted rounded-md p-0.5 gap-0.5 self-start">
      {ENGAGEMENT_PERIODS.map((p) => {
        const active = p.id === value
        const pill = nativeActivePill(active, { webShadow: false })
        return (
          <Pressable
            key={p.id}
            onPress={() => onChange(p.id)}
            className={cn('px-3 h-8 items-center justify-center rounded', pill.className)}
            style={pill.style}
          >
            <Text className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>
              {p.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function WorkTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: string
  sub?: string
}) {
  return (
    <View className="flex-1 min-w-[140px] rounded-lg bg-muted/40 border border-border/50 p-3">
      <View className="flex-row items-center gap-1.5 mb-1">
        <Icon size={13} className="text-primary" />
        <Text className="text-[11px] text-muted-foreground">{label}</Text>
      </View>
      <Text className="text-lg font-bold text-foreground">{value}</Text>
      {sub ? <Text className="text-[11px] text-muted-foreground mt-0.5">{sub}</Text> : null}
    </View>
  )
}

function RecentList({ items }: { items: RecentWorkItem[] }) {
  if (items.length === 0) return null
  return (
    <View className="gap-1.5 pt-1">
      <Text className="text-xs font-medium text-muted-foreground">Recent</Text>
      {items.map((item, i) => {
        const Icon = item.kind === 'approval' ? ShieldCheck : CheckCircle2
        return (
          <View key={`${item.at}-${i}`} className="flex-row items-start gap-2">
            <Icon size={14} className="text-muted-foreground mt-0.5" />
            <View className="flex-1">
              <Text className="text-xs text-foreground" numberOfLines={2}>
                {item.label}
              </Text>
              {item.detail ? (
                <Text className="text-[11px] text-muted-foreground" numberOfLines={2}>
                  {item.detail}
                </Text>
              ) : null}
            </View>
            <Text className="text-[11px] text-muted-foreground">
              {new Date(item.at).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function isEmpty(stats: EngagementStats): boolean {
  const t = stats.totals
  return t.activeDays === 0 && t.tokens === 0
}

// ============================================================================
// Dashboard
// ============================================================================

export function UsageDashboard({
  source,
  title,
  subtitle,
  initialPeriod = '30d',
}: {
  source: DashboardSource
  title?: string
  subtitle?: string
  initialPeriod?: EngagementPeriod
}) {
  const comfortable = useIsNativePhoneLayout()
  const [period, setPeriod] = useState<EngagementPeriod>(initialPeriod)
  const { data, loading, error, reload } = useEngagement(source, period)

  // A whole-workspace view aggregates several people, so "streak" means days anyone was active.
  const isTeam = source.kind === 'workspace' && !source.userId
  const periodHint = period === 'all' ? 'Streaks cover the last 2 years' : 'Streaks are counted within this range'

  const header = (
    <View className="flex-row items-start justify-between flex-wrap gap-2">
      <View className="flex-1 min-w-[180px]">
        {title ? <Text className="text-base font-semibold text-foreground">{title}</Text> : null}
        {subtitle ? <Text className="text-xs text-muted-foreground">{subtitle}</Text> : null}
      </View>
      <RangeSwitch value={period} onChange={setPeriod} />
    </View>
  )

  if (!data) {
    return (
      <View className="gap-3">
        {header}
        <View className="rounded-xl border border-border bg-card p-8 items-center justify-center gap-2">
          {loading ? (
            <ActivityIndicator />
          ) : (
            <>
              <Text className="text-sm text-muted-foreground">{error ?? 'No activity data'}</Text>
              <Pressable onPress={reload} className="px-3 h-8 items-center justify-center rounded-md border border-border">
                <Text className="text-xs font-medium text-foreground">Retry</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    )
  }

  const t = data.totals
  const series = data.daily.models.map((model, i) => ({
    id: model,
    label: model,
    color: seriesColor(model, i, STACKED_PALETTE),
  }))
  const hasTokens = data.daily.days.some((d) => d.total > 0)
  const empty = isEmpty(data)

  return (
    <View className={cn('gap-3', loading && 'opacity-60')}>
      {header}

      {empty ? (
        <View className="rounded-xl border border-border bg-card p-6 items-center">
          <Text className="text-sm text-muted-foreground">No activity in this period yet.</Text>
        </View>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        <StatCard label="Tokens" value={compactNumber(t.tokens)} icon={Zap} comfortable={comfortable} />
        <StatCard label="Sessions" value={t.sessions} icon={MessageSquare} comfortable={comfortable} />
        <StatCard label="Active days" value={t.activeDays} icon={CalendarDays} comfortable={comfortable} />
        <StatCard
          label={isTeam ? 'Team streak' : 'Current streak'}
          value={pluralDays(data.streak.current)}
          icon={Flame}
          subtitle={periodHint}
          comfortable={comfortable}
        />
        <StatCard
          label="Longest streak"
          value={pluralDays(data.streak.longest)}
          icon={Trophy}
          comfortable={comfortable}
        />
        <StatCard
          label="Peak hour"
          value={formatHourLabel(data.peakHour)}
          icon={Clock}
          subtitle={data.tz}
          comfortable={comfortable}
        />
        <StatCard
          label="Spend"
          value={formatDollarCost(t.spendUsd)}
          icon={Coins}
          subtitle={`${compactNumber(t.agentRequests)} agent requests`}
          comfortable={comfortable}
        />
      </View>

      <Panel title="Work activity" subtitle="What got done in this period">
        <View className="flex-row flex-wrap gap-2">
          <WorkTile
            icon={ShieldCheck}
            label="Approvals decided"
            value={String(t.approvalsDecided)}
            sub={`${t.approvalsApproved} approved · ${t.approvalsDenied} denied`}
          />
          <WorkTile
            icon={CheckCircle2}
            label="Tasks completed"
            value={String(t.tasksCompleted)}
            sub={`${t.tasksStarted} started`}
          />
          <WorkTile
            icon={MessageSquare}
            label="Messages sent"
            value={compactNumber(t.messagesSent)}
            sub="Team chat"
          />
          <WorkTile
            icon={Code2}
            label="Lines changed"
            value={compactNumber(t.linesAdded + t.linesRemoved)}
            sub={`+${compactNumber(t.linesAdded)} / −${compactNumber(t.linesRemoved)}`}
          />
          <WorkTile icon={FolderOpen} label="Projects touched" value={String(t.projectsTouched)} />
          <WorkTile icon={Wrench} label="Tool calls" value={compactNumber(t.toolCalls)} />
          <WorkTile icon={Video} label="Meetings" value={String(t.meetings)} />
        </View>
        <RecentList items={data.recent} />
      </Panel>

      <Panel title="Daily token usage" subtitle="Tokens per day, stacked by model. Hover a day for its model breakdown.">
        {hasTokens ? (
          <StackedAreaChart
            days={data.daily.days.map((d) => ({ date: d.date, values: d.byModel }))}
            series={series}
            height={220}
            formatY={compactNumber}
            formatTooltip={(n) => n.toLocaleString()}
          />
        ) : (
          <View className="h-[120px] items-center justify-center">
            <Text className="text-sm text-muted-foreground">No token usage in this period</Text>
          </View>
        )}
      </Panel>

      <Panel title="Activity" subtitle="Every approval, message, task and agent request counts as a day of work">
        <ActivityHeatmap cells={data.heatmap} />
        <View className="gap-1 pt-2">
          <Text className="text-xs font-medium text-muted-foreground">When work happens ({data.tz})</Text>
          <HourOfWeekGrid matrix={data.hourOfWeek} />
        </View>
      </Panel>

      <View className="flex-row flex-wrap gap-3">
        <View className="flex-1 min-w-[280px]">
          <Panel title="Models" subtitle="Share of tokens">
            <ModelShareDonut rows={data.modelShare} />
          </Panel>
        </View>
        <View className="flex-1 min-w-[280px]">
          <Panel title="Top tools" subtitle="Most-used agent tools">
            {data.topTools.length === 0 ? (
              <Text className="text-sm text-muted-foreground">No tool calls in this period</Text>
            ) : (
              <View className="gap-2">
                {data.topTools.map((tool) => {
                  const max = data.topTools[0].count || 1
                  return (
                    <View key={tool.toolName} className="gap-1">
                      <View className="flex-row items-center justify-between">
                        <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
                          {tool.toolName}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          {tool.count.toLocaleString()} · {Math.round(tool.successRate * 100)}% ok
                        </Text>
                      </View>
                      <View className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <View
                          className="h-1.5 rounded-full bg-primary"
                          style={{ width: `${Math.max(4, (tool.count / max) * 100)}%` }}
                        />
                      </View>
                    </View>
                  )
                })}
              </View>
            )}
          </Panel>
        </View>
      </View>
    </View>
  )
}
