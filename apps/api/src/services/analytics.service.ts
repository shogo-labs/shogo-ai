// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics Service - Scope-based analytics for platform, workspace, and project levels
 *
 * Every function accepts an optional AnalyticsScope so the same logic serves:
 * - Platform-wide analytics (no scope, super admin only)
 * - Workspace-level analytics (scope = { workspaceId })
 * - Project-level analytics (scope = { workspaceId, projectId })
 */

import { prisma, Prisma } from '../lib/prisma'
import { resolveModelLabels } from './model-registry.service'

/** Parse actionMetadata that may have been double-JSON-stringified. */
function parseMeta(raw: unknown): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, any>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

function voiceLabel(actionType: string): string {
  switch (actionType) {
    case 'voice_minutes_inbound':
      return 'Voice · inbound'
    case 'voice_minutes_outbound':
      return 'Voice · outbound'
    case 'voice_number_setup':
      return 'Voice · number setup'
    case 'voice_number_monthly':
      return 'Voice · number monthly'
    default:
      return 'Voice'
  }
}

// ============================================================================
// Types
// ============================================================================

export interface AnalyticsScope {
  workspaceId?: string
  projectId?: string
  userId?: string
}

export type AnalyticsPeriod = '1d' | '7d' | '30d' | '90d' | '1y' | 'mtd' | 'last_month'

/**
 * Resolve a period (or explicit `from`/`to` ISO dates) into an inclusive
 * `[from, to]` window. Used by the new dashboard date-range pills which
 * support `1d`, `mtd`, `last_month`, and custom ranges in addition to the
 * legacy `7d / 30d / 90d / 1y` rolling windows.
 */
export function periodToWindow(
  period?: AnalyticsPeriod,
  fromIso?: string,
  toIso?: string,
): { from: Date; to: Date } {
  const now = new Date()
  if (fromIso && toIso) {
    const from = new Date(fromIso)
    const to = new Date(toIso)
    if (!isNaN(from.getTime()) && !isNaN(to.getTime())) return { from, to }
  }
  switch (period) {
    case '1d':
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now }
    case 'mtd':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: start, to: end }
    }
    case '90d':
      return { from: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), to: now }
    case '1y':
      return { from: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), to: now }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now }
    case '30d':
    default:
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: now }
  }
}

interface TimeSeriesPoint {
  date: string
  count: number
}

// ============================================================================
// Helpers
// ============================================================================

function periodToDate(period: AnalyticsPeriod): Date {
  return periodToWindow(period).from
}

/**
 * Build Prisma where clause fragments from scope.
 * Returns an object that can be spread into a where clause.
 */
function scopeWhere(scope: AnalyticsScope) {
  return {
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.userId ? { memberId: scope.userId } : {}),
  }
}

/**
 * Group raw rows by truncated date string for time series.
 */
function groupByDate(rows: { createdAt: Date }[]): TimeSeriesPoint[] {
  const map = new Map<string, number>()
  for (const row of rows) {
    const date = row.createdAt.toISOString().split('T')[0]
    map.set(date, (map.get(date) || 0) + 1)
  }
  return Array.from(map.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Merge multiple named time series into a single array of objects keyed by date.
 * E.g. { users: [{date, count}], projects: [{date, count}] }
 *   → [{ date, users: 3, projects: 1 }, ...]
 */
function mergeTimeSeries(
  series: Record<string, TimeSeriesPoint[]>
): Record<string, unknown>[] {
  const keys = Object.keys(series)
  const dateMap = new Map<string, Record<string, unknown>>()

  for (const key of keys) {
    for (const point of series[key]) {
      if (!dateMap.has(point.date)) {
        const entry: Record<string, unknown> = { date: point.date }
        for (const k of keys) entry[k] = 0
        dateMap.set(point.date, entry)
      }
      dateMap.get(point.date)![key] = point.count
    }
  }

  return Array.from(dateMap.values()).sort((a, b) =>
    (a.date as string).localeCompare(b.date as string)
  )
}

// ============================================================================
// Overview Stats
// ============================================================================

/**
 * Get overview statistics. Counts depend on scope:
 * - No scope: total users, workspaces, projects, chat sessions
 * - Workspace scope: members, projects, chat sessions in that workspace
 * - Project scope: chat sessions, usage events for that project
 * - User scope: usage events, messages, sessions for that user across all workspaces
 */
export async function getOverviewStats(scope: AnalyticsScope = {}) {
  if (scope.userId && !scope.workspaceId && !scope.projectId) {
    const [usageEvents, totalBilledUsdResult, chatSessions] = await Promise.all([
      prisma.usageEvent.count({
        where: { memberId: scope.userId },
      }),
      prisma.usageEvent.aggregate({
        where: { memberId: scope.userId },
        _sum: { billedUsd: true },
      }),
      prisma.chatSession.count({
        where: {
          project: {
            workspace: {
              members: { some: { userId: scope.userId } },
            },
          },
        },
      }),
    ])
    return {
      usageEvents,
      totalSpendUsd: totalBilledUsdResult._sum.billedUsd ?? 0,
      chatSessions,
    }
  }

  if (scope.projectId) {
    // Project-level overview
    const [chatSessions, usageEvents, messages] = await Promise.all([
      prisma.chatSession.count({
        where: { contextId: scope.projectId },
      }),
      prisma.usageEvent.count({
        where: { projectId: scope.projectId },
      }),
      prisma.chatMessage.count({
        where: {
          role: 'user',
          agent: 'technical',
          session: { contextId: scope.projectId },
        },
      }),
    ])
    return { chatSessions, usageEvents, messages }
  }

  if (scope.workspaceId) {
    // Workspace-level overview
    const [members, projects, chatSessions, usageEvents] = await Promise.all([
      prisma.member.count({
        where: { workspaceId: scope.workspaceId },
      }),
      prisma.project.count({
        where: { workspaceId: scope.workspaceId },
      }),
      prisma.chatSession.count({
        where: {
          project: { workspaceId: scope.workspaceId },
        },
      }),
      prisma.usageEvent.count({
        where: { workspaceId: scope.workspaceId },
      }),
    ])
    return { members, projects, chatSessions, usageEvents }
  }

  // Platform-wide overview
  const [totalUsers, totalWorkspaces, totalProjects, totalChatSessions, activeSubscriptions] =
    await Promise.all([
      prisma.user.count(),
      prisma.workspace.count(),
      prisma.project.count(),
      prisma.chatSession.count(),
      prisma.subscription.count({
        where: { status: 'active' },
      }),
    ])

  return {
    totalUsers,
    totalWorkspaces,
    totalProjects,
    totalChatSessions,
    activeSubscriptions,
  }
}

// ============================================================================
// Growth Time Series
// ============================================================================

/**
 * Get growth time series data (new entities created per day).
 */
export async function getGrowthTimeSeries(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d'
) {
  const since = periodToDate(period)

  if (scope.workspaceId) {
    // Workspace: new projects and members over time
    const [projects, members] = await Promise.all([
      prisma.project.findMany({
        where: { workspaceId: scope.workspaceId, createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.member.findMany({
        where: { workspaceId: scope.workspaceId, createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    return mergeTimeSeries({
      projects: groupByDate(projects),
      members: groupByDate(members),
    })
  }

  // Platform-wide: new users, workspaces, projects over time
  const [users, workspaces, projects] = await Promise.all([
    prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.workspace.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.project.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return mergeTimeSeries({
    users: groupByDate(users),
    workspaces: groupByDate(workspaces),
    projects: groupByDate(projects),
  })
}

// ============================================================================
// Activity Timeseries (combined daily metrics)
// ============================================================================

export interface ActivityTimeseriesPoint {
  date: string
  newUsers: number
  newWorkspaces: number
  newProjects: number
  messages: number
  sessions: number
  toolCalls: number
}

/**
 * Combined daily activity series: new users (members in workspace scope),
 * new workspaces, new projects, user messages, chat sessions, and tool calls.
 * Zero-fills every day in the window so charts never jump over a gap.
 * Scope-aware: `{}` = platform-wide, `{ workspaceId }` = one workspace.
 */
export async function getActivityTimeseries(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
): Promise<ActivityTimeseriesPoint[]> {
  const { from, to } = periodToWindow(period)

  // Session scope fragment shared by messages / sessions / tool calls.
  const sessionScope: any = {}
  if (scope.projectId) sessionScope.contextId = scope.projectId
  else if (scope.workspaceId) sessionScope.project = { workspaceId: scope.workspaceId }
  const hasSessionScope = Object.keys(sessionScope).length > 0

  const [users, workspaces, projects, messages, sessions, toolCalls] = await Promise.all([
    // newUsers → platform: signups; workspace: new members
    scope.workspaceId
      ? prisma.member.findMany({
          where: { workspaceId: scope.workspaceId, createdAt: { gte: from, lt: to } },
          select: { createdAt: true },
        })
      : prisma.user.findMany({
          where: { createdAt: { gte: from, lt: to } },
          select: { createdAt: true },
        }),
    scope.workspaceId
      ? Promise.resolve([] as { createdAt: Date }[])
      : prisma.workspace.findMany({
          where: { createdAt: { gte: from, lt: to } },
          select: { createdAt: true },
        }),
    prisma.project.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      },
      select: { createdAt: true },
    }),
    prisma.chatMessage.findMany({
      where: {
        role: 'user',
        agent: 'technical',
        createdAt: { gte: from, lt: to },
        ...(hasSessionScope ? { session: sessionScope } : {}),
      },
      select: { createdAt: true },
    }),
    prisma.chatSession.findMany({
      where: { createdAt: { gte: from, lt: to }, ...sessionScope },
      select: { createdAt: true },
    }),
    prisma.toolCallLog.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        ...(hasSessionScope ? { chatSession: sessionScope } : {}),
      },
      select: { createdAt: true },
    }),
  ])

  const bucket = (rows: { createdAt: Date }[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const d = isoDay(r.createdAt)
      m.set(d, (m.get(d) ?? 0) + 1)
    }
    return m
  }
  const uM = bucket(users)
  const wM = bucket(workspaces)
  const pM = bucket(projects)
  const mM = bucket(messages)
  const sM = bucket(sessions)
  const tM = bucket(toolCalls)

  const days: ActivityTimeseriesPoint[] = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const last = new Date(to)
  last.setUTCHours(0, 0, 0, 0)
  while (cursor <= last) {
    const key = isoDay(cursor)
    days.push({
      date: key,
      newUsers: uM.get(key) ?? 0,
      newWorkspaces: wM.get(key) ?? 0,
      newProjects: pM.get(key) ?? 0,
      messages: mM.get(key) ?? 0,
      sessions: sM.get(key) ?? 0,
      toolCalls: tM.get(key) ?? 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

// ============================================================================
// Member Usage Stats (People table)
// ============================================================================

/**
 * Per-member USD usage for the people/settings table.
 *
 * Returns the current-month spend split across the three buckets that show
 * in the Members UI (Image 3 of the billing UX refresh):
 * - `included`  → seat-bound monthly allocation (UsageEvent.source = 'monthly')
 * - `free`      → daily allowance (UsageEvent.source = 'daily')
 * - `onDemand`  → overage / trust-block charges (UsageEvent.source = 'overage')
 *
 * `monthly` and `total` are kept for backwards-compatibility with older
 * callers that just want a single $ figure. `monthly` is the sum across all
 * three buckets for the current month; `total` is all-time spend.
 */
export async function getMemberUsageStats(
  workspaceId: string
): Promise<{
  monthly: Record<string, number>
  total: Record<string, number>
  included: Record<string, number>
  free: Record<string, number>
  onDemand: Record<string, number>
}> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [bucketRows, totalRows] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ['memberId', 'source'],
      where: { workspaceId, createdAt: { gte: monthStart } },
      _sum: { billedUsd: true },
    }),
    prisma.usageEvent.groupBy({
      by: ['memberId'],
      where: { workspaceId },
      _sum: { billedUsd: true },
    }),
  ])

  const included: Record<string, number> = {}
  const free: Record<string, number> = {}
  const onDemand: Record<string, number> = {}
  const monthly: Record<string, number> = {}

  for (const row of bucketRows) {
    const sum = row._sum.billedUsd ?? 0
    monthly[row.memberId] = (monthly[row.memberId] ?? 0) + sum
    switch (row.source) {
      case 'monthly':
        included[row.memberId] = (included[row.memberId] ?? 0) + sum
        break
      case 'daily':
        free[row.memberId] = (free[row.memberId] ?? 0) + sum
        break
      case 'overage':
        onDemand[row.memberId] = (onDemand[row.memberId] ?? 0) + sum
        break
      default:
        // Unknown source — count toward included so spend isn't lost in the UI.
        included[row.memberId] = (included[row.memberId] ?? 0) + sum
    }
  }

  const total: Record<string, number> = {}
  for (const row of totalRows) {
    total[row.memberId] = row._sum.billedUsd ?? 0
  }

  return { monthly, total, included, free, onDemand }
}

// ============================================================================
// Usage Analytics
// ============================================================================

/**
 * Get usage analytics - USD consumption by action type, top consumers.
 */
export async function getUsageAnalytics(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d'
) {
  const since = periodToDate(period)
  const where = {
    ...scopeWhere(scope),
    createdAt: { gte: since },
  }

  const events = await prisma.usageEvent.findMany({
    where,
    select: {
      actionType: true,
      billedUsd: true,
      source: true,
      memberId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  // Aggregate by action type
  const byActionType = new Map<string, { count: number; totalSpendUsd: number }>()
  for (const event of events) {
    const existing = byActionType.get(event.actionType) || { count: 0, totalSpendUsd: 0 }
    existing.count += 1
    existing.totalSpendUsd += event.billedUsd
    byActionType.set(event.actionType, existing)
  }

  // Aggregate by usage source (daily/monthly/overage)
  const bySource = new Map<string, number>()
  for (const event of events) {
    bySource.set(
      event.source,
      (bySource.get(event.source) || 0) + event.billedUsd
    )
  }

  // Top consumers by member
  const byMember = new Map<string, number>()
  for (const event of events) {
    byMember.set(event.memberId, (byMember.get(event.memberId) || 0) + event.billedUsd)
  }
  const topConsumers = Array.from(byMember.entries())
    .map(([memberId, totalSpendUsd]) => ({ memberId, totalSpendUsd }))
    .sort((a, b) => b.totalSpendUsd - a.totalSpendUsd)
    .slice(0, 10)

  // Daily usage time series
  const dailyUsage = groupByDate(events)

  // Total USD spent
  const totalSpendUsd = events.reduce((sum, e) => sum + e.billedUsd, 0)

  return {
    totalEvents: events.length,
    totalSpendUsd,
    byActionType: Object.fromEntries(byActionType),
    bySource: Object.fromEntries(bySource),
    topConsumers,
    dailyUsage,
  }
}

// ============================================================================
// Spend Timeseries (Stacked Area Chart)
// ============================================================================

/** Daily $ spend grouped by model — used by the Team Usage stacked-area chart. */
export interface SpendTimeseriesPoint {
  date: string
  byModel: Record<string, number>
  total: number
}

export interface SpendTimeseriesData {
  days: SpendTimeseriesPoint[]
  totals: {
    totalSpendUsd: number
    totalIncludedUsd: number
    totalOnDemandUsd: number
    uniqueModels: number
  }
  models: string[]
  groupBy: 'model' | 'workspace' | 'user' | 'source'
  metric: 'spend' | 'tokens' | 'requests'
}

/** ISO yyyy-mm-dd string in UTC. */
function isoDay(d: Date): string {
  return d.toISOString().split('T')[0]
}

/**
 * Daily spend (or token / request count) over the period, grouped by model
 * (or user / source). Zero-fills missing days so the rendered chart never
 * jumps over a gap.
 */
export async function getSpendTimeseries(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
  options: {
    fromIso?: string
    toIso?: string
    groupBy?: 'model' | 'workspace' | 'user' | 'source'
    metric?: 'spend' | 'tokens' | 'requests'
    topN?: number
  } = {}
): Promise<SpendTimeseriesData> {
  const { from, to } = periodToWindow(period, options.fromIso, options.toIso)
  const groupBy = options.groupBy ?? 'model'
  const metric = options.metric ?? 'spend'
  const topN = options.topN ?? 8

  const where: any = {
    ...scopeWhere(scope),
    actionType: {
      in: [
        'ai_proxy_completion',
        'chat_message',
        'voice_minutes_inbound',
        'voice_minutes_outbound',
        'voice_number_setup',
        'voice_number_monthly',
      ],
    },
    createdAt: { gte: from, lt: to },
  }

  const events = await prisma.usageEvent.findMany({
    where,
    select: {
      memberId: true,
      workspaceId: true,
      billedUsd: true,
      rawUsd: true,
      source: true,
      actionMetadata: true,
      createdAt: true,
    },
  })

  // Resolve user emails up front for groupBy:user
  let userMap = new Map<string, string>()
  if (groupBy === 'user') {
    const ids = [...new Set(events.map((e) => e.memberId).filter((id) => id !== 'system'))]
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, name: true },
    })
    userMap = new Map(users.map((u) => [u.id, u.email || u.name || u.id]))
  }

  // Resolve workspace names up front for groupBy:workspace
  let workspaceMap = new Map<string, string>()
  if (groupBy === 'workspace') {
    const ids = [...new Set(events.map((e) => e.workspaceId).filter(Boolean))]
    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })
    workspaceMap = new Map(workspaces.map((w) => [w.id, w.name || w.id]))
  }

  // Resolve model ids → display names when grouping by model (post catalog-uuid
  // migration the stored ids are UUIDs).
  let modelLabels = new Map<string, string>()
  if (groupBy === 'model') {
    modelLabels = await resolveModelLabels(
      events.map((e) => {
        const m = parseMeta(e.actionMetadata)
        return (m.model || m.modelUsed || 'unknown') as string
      }),
    )
  }

  // Aggregate {date → {seriesKey → metric value}} and totals
  const byDay = new Map<string, Map<string, number>>()
  const seriesTotals = new Map<string, number>()
  let totalSpendUsd = 0
  let totalIncludedUsd = 0
  let totalOnDemandUsd = 0

  // For "spend" metric we want the *actual cost incurred* — `billedUsd` is 0
  // for events covered by included plan quota or running in local mode, so we
  // fall back to `rawUsd` (the underlying provider cost recorded on the event
  // and inside `actionMetadata`). This way the chart is always meaningful even
  // when nothing has been charged yet.
  const eventCostUsd = (event: { billedUsd: number; rawUsd: number | null; actionMetadata: unknown }, meta: Record<string, any>): number => {
    if (event.billedUsd > 0) return event.billedUsd
    if (event.rawUsd != null && event.rawUsd > 0) return event.rawUsd
    const metaRaw = (meta.rawUsd as number | undefined) ?? (meta.dollarCost as number | undefined)
    return typeof metaRaw === 'number' ? metaRaw : 0
  }

  for (const event of events) {
    const meta = parseMeta(event.actionMetadata)
    const day = isoDay(event.createdAt)
    const costUsd = eventCostUsd(event, meta)

    const rawModel = meta.model || meta.modelUsed || 'unknown'
    const series =
      groupBy === 'user'
        ? userMap.get(event.memberId) ?? event.memberId
        : groupBy === 'workspace'
          ? (workspaceMap.get(event.workspaceId) ?? event.workspaceId)
          : groupBy === 'source'
            ? event.source
            : (modelLabels.get(rawModel) ?? rawModel)

    const value =
      metric === 'tokens'
        ? meta.totalTokens || 0
        : metric === 'requests'
          ? 1
          : costUsd

    if (!byDay.has(day)) byDay.set(day, new Map())
    const dayMap = byDay.get(day)!
    dayMap.set(series, (dayMap.get(series) ?? 0) + value)
    seriesTotals.set(series, (seriesTotals.get(series) ?? 0) + value)

    totalSpendUsd += costUsd
    if (event.source === 'overage') totalOnDemandUsd += costUsd
    else totalIncludedUsd += costUsd
  }

  // Pick top-N series by total; collapse the rest into "Other"
  const ranked = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1])
  const top = new Set(ranked.slice(0, topN).map(([k]) => k))
  const collapsed = new Set(ranked.slice(topN).map(([k]) => k))
  const includeOther = collapsed.size > 0
  const models = ranked.slice(0, topN).map(([k]) => k)
  if (includeOther) models.push('Other')

  // Zero-fill day buckets
  const days: SpendTimeseriesPoint[] = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const last = new Date(to)
  last.setUTCHours(0, 0, 0, 0)
  while (cursor <= last) {
    const key = isoDay(cursor)
    const sourceMap = byDay.get(key) ?? new Map()
    const byModel: Record<string, number> = {}
    for (const m of models) byModel[m] = 0
    let dayTotal = 0
    for (const [series, value] of sourceMap.entries()) {
      const targetKey = top.has(series) ? series : (collapsed.has(series) ? 'Other' : series)
      byModel[targetKey] = (byModel[targetKey] ?? 0) + value
      dayTotal += value
    }
    days.push({ date: key, byModel, total: dayTotal })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return {
    days,
    totals: {
      totalSpendUsd,
      totalIncludedUsd,
      totalOnDemandUsd,
      uniqueModels: seriesTotals.size,
    },
    models,
    groupBy,
    metric,
  }
}

// ============================================================================
// Active Users
// ============================================================================

/**
 * Get active user metrics based on auth sessions and chat activity.
 *
 * Uses multiple signals to determine user activity:
 * 1. Auth session activity (Session.updatedAt) — most reliable, updated on every request
 * 2. Chat session creation (ChatSession.createdAt) — captures AI usage
 *
 * For scoped queries (workspace/project), falls back to usage events since
 * auth sessions are not workspace-scoped.
 */
export async function getActiveUsers(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d'
) {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // For workspace/project scope, use membership + usage events
  if (scope.workspaceId || scope.projectId) {
    const baseWhere = scopeWhere(scope)

    const [dauEvents, wauEvents, mauEvents] = await Promise.all([
      prisma.usageEvent.findMany({
        where: { ...baseWhere, createdAt: { gte: dayAgo } },
        select: { memberId: true },
        distinct: ['memberId'],
      }),
      prisma.usageEvent.findMany({
        where: { ...baseWhere, createdAt: { gte: weekAgo } },
        select: { memberId: true },
        distinct: ['memberId'],
      }),
      prisma.usageEvent.findMany({
        where: { ...baseWhere, createdAt: { gte: monthAgo } },
        select: { memberId: true },
        distinct: ['memberId'],
      }),
    ])

    return {
      dau: dauEvents.length,
      wau: wauEvents.length,
      mau: mauEvents.length,
    }
  }

  // Platform-wide: use auth session activity (updatedAt tracks last request)
  const [dauSessions, wauSessions, mauSessions] = await Promise.all([
    prisma.session.findMany({
      where: { updatedAt: { gte: dayAgo } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.session.findMany({
      where: { updatedAt: { gte: weekAgo } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.session.findMany({
      where: { updatedAt: { gte: monthAgo } },
      select: { userId: true },
      distinct: ['userId'],
    }),
  ])

  return {
    dau: dauSessions.length,
    wau: wauSessions.length,
    mau: mauSessions.length,
  }
}

// ============================================================================
// Active Users Timeseries (rolling DAU / WAU / MAU)
// ============================================================================

export interface ActiveUsersTimeseriesPoint {
  date: string
  dau: number
  wau: number
  mau: number
}

/** Union the distinct-member sets for the `windowDays` ending on `day`. */
function rollingUnionSize(
  byDay: Map<string, Set<string>>,
  day: Date,
  windowDays: number,
): number {
  const u = new Set<string>()
  const cursor = new Date(day)
  for (let i = 0; i < windowDays; i++) {
    const set = byDay.get(isoDay(cursor))
    if (set) for (const id of set) u.add(id)
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return u.size
}

/**
 * Daily active-user trend. DAU = distinct active members that day; WAU/MAU are
 * rolling 7 / 30-day distinct counts. Activity is derived from usage events
 * (each carries `createdAt` + `memberId`), with a 29-day lookback so the
 * rolling windows are correct from the first rendered day.
 */
export async function getActiveUsersTimeseries(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
): Promise<ActiveUsersTimeseriesPoint[]> {
  const { from, to } = periodToWindow(period)
  const lookbackFrom = new Date(from.getTime() - 29 * 24 * 60 * 60 * 1000)

  const where: any = { createdAt: { gte: lookbackFrom, lt: to } }
  if (scope.workspaceId) where.workspaceId = scope.workspaceId
  if (scope.projectId) where.projectId = scope.projectId

  const events = await prisma.usageEvent.findMany({
    where,
    select: { memberId: true, createdAt: true },
  })

  const byDay = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.memberId === 'system') continue
    const d = isoDay(e.createdAt)
    if (!byDay.has(d)) byDay.set(d, new Set())
    byDay.get(d)!.add(e.memberId)
  }

  const days: ActiveUsersTimeseriesPoint[] = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const last = new Date(to)
  last.setUTCHours(0, 0, 0, 0)
  while (cursor <= last) {
    days.push({
      date: isoDay(cursor),
      dau: byDay.get(isoDay(cursor))?.size ?? 0,
      wau: rollingUnionSize(byDay, cursor, 7),
      mau: rollingUnionSize(byDay, cursor, 30),
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

// ============================================================================
// Quality & Efficiency Timeseries
// ============================================================================

export interface QualityTimeseriesPoint {
  date: string
  cacheHitRatio: number
  costPerMessage: number
  costPerActiveUser: number
  agentEscalatedRate: number
  agentLoopRate: number
  agentMaxTurnsRate: number
}

/**
 * Daily quality & efficiency series: cache hit ratio and unit economics from
 * usage events, plus agent quality rates from agent cost metrics. Rates are
 * returned as percentages (0-100); costs in USD. Zero-filled per day.
 */
export async function getQualityTimeseries(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
): Promise<QualityTimeseriesPoint[]> {
  const { from, to } = periodToWindow(period)

  const usageWhere: any = {
    actionType: {
      in: ['ai_proxy_completion', 'chat_message'],
    },
    createdAt: { gte: from, lt: to },
  }
  if (scope.workspaceId) usageWhere.workspaceId = scope.workspaceId
  if (scope.projectId) usageWhere.projectId = scope.projectId

  const sessionScope: any = {}
  if (scope.projectId) sessionScope.contextId = scope.projectId
  else if (scope.workspaceId) sessionScope.project = { workspaceId: scope.workspaceId }
  const hasSessionScope = Object.keys(sessionScope).length > 0

  const agentWhere: any = { createdAt: { gte: from, lt: to } }
  if (scope.workspaceId) agentWhere.workspaceId = scope.workspaceId
  if (scope.projectId) agentWhere.projectId = scope.projectId

  const [events, messages, agentRuns] = await Promise.all([
    prisma.usageEvent.findMany({
      where: usageWhere,
      select: { memberId: true, billedUsd: true, rawUsd: true, actionMetadata: true, createdAt: true },
    }),
    prisma.chatMessage.findMany({
      where: {
        role: 'user',
        agent: 'technical',
        createdAt: { gte: from, lt: to },
        ...(hasSessionScope ? { session: sessionScope } : {}),
      },
      select: { createdAt: true },
    }),
    prisma.agentCostMetric.findMany({
      where: agentWhere,
      select: { createdAt: true, escalated: true, loopDetected: true, hitMaxTurns: true },
    }),
  ])

  // Per-day accumulators.
  interface Acc {
    cached: number
    input: number
    spend: number
    activeUsers: Set<string>
    messages: number
    runs: number
    escalated: number
    loop: number
    maxTurns: number
  }
  const acc = new Map<string, Acc>()
  const ensure = (d: string): Acc => {
    let a = acc.get(d)
    if (!a) {
      a = { cached: 0, input: 0, spend: 0, activeUsers: new Set(), messages: 0, runs: 0, escalated: 0, loop: 0, maxTurns: 0 }
      acc.set(d, a)
    }
    return a
  }

  for (const e of events) {
    const meta = parseMeta(e.actionMetadata)
    const a = ensure(isoDay(e.createdAt))
    a.cached += (meta.cachedInputTokens as number) || 0
    a.input += (meta.inputTokens as number) || 0
    const cost = e.billedUsd > 0
      ? e.billedUsd
      : (e.rawUsd != null && e.rawUsd > 0)
        ? e.rawUsd
        : ((meta.rawUsd as number | undefined) ?? (meta.dollarCost as number | undefined) ?? 0)
    a.spend += cost
    if (e.memberId !== 'system') a.activeUsers.add(e.memberId)
  }
  for (const m of messages) ensure(isoDay(m.createdAt)).messages += 1
  for (const r of agentRuns) {
    const a = ensure(isoDay(r.createdAt))
    a.runs += 1
    if (r.escalated) a.escalated += 1
    if (r.loopDetected) a.loop += 1
    if (r.hitMaxTurns) a.maxTurns += 1
  }

  const pct = (num: number, den: number) => (den > 0 ? (num / den) * 100 : 0)

  const days: QualityTimeseriesPoint[] = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const last = new Date(to)
  last.setUTCHours(0, 0, 0, 0)
  while (cursor <= last) {
    const key = isoDay(cursor)
    const a = acc.get(key)
    const activeUsers = a?.activeUsers.size ?? 0
    days.push({
      date: key,
      cacheHitRatio: a ? pct(a.cached, a.cached + a.input) : 0,
      costPerMessage: a && a.messages > 0 ? a.spend / a.messages : 0,
      costPerActiveUser: a && activeUsers > 0 ? a.spend / activeUsers : 0,
      agentEscalatedRate: a ? pct(a.escalated, a.runs) : 0,
      agentLoopRate: a ? pct(a.loop, a.runs) : 0,
      agentMaxTurnsRate: a ? pct(a.maxTurns, a.runs) : 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

// ============================================================================
// Usage Log (AI Proxy Completions)
// ============================================================================

/** A single usage event with user info and extracted metadata. */
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
  /**
   * Raw action type (e.g. `ai_proxy_completion`, `voice_minutes_inbound`).
   * UIs can switch on this to render a badge; older entries may omit it.
   */
  actionType?: string
  /**
   * Metadata snapshot useful for the billing panel (voice call direction,
   * phone numbers, billed minutes). Opaque record — UIs should feature-detect.
   */
  metadata?: Record<string, unknown>
}

/** Aggregated usage per user+model pair. */
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

/**
 * Get a paginated log of AI proxy usage events with user info.
 * Scope-aware: no scope = platform-wide, workspaceId = workspace-scoped.
 */
export async function getUsageLog(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
  options: { page?: number; limit?: number; userId?: string; model?: string } = {}
) {
  const since = periodToDate(period)
  const page = options.page ?? 1
  const limit = Math.min(options.limit ?? 50, 100)

  const where: any = {
    actionType: {
      in: [
        'ai_proxy_completion',
        'chat_message',
        'voice_minutes_inbound',
        'voice_minutes_outbound',
        'voice_number_setup',
        'voice_number_monthly',
      ],
    },
    createdAt: { gte: since },
  }
  if (scope.workspaceId) where.workspaceId = scope.workspaceId
  if (scope.projectId) where.projectId = scope.projectId
  if (scope.userId) where.memberId = scope.userId
  if (options.userId) where.memberId = options.userId
  if (options.model) {
    where.actionMetadata = { path: ['model'], string_contains: options.model }
  }

  const [events, total] = await Promise.all([
    prisma.usageEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.usageEvent.count({ where }),
  ])

  // Collect unique userIds from memberId field
  const userIds = [...new Set(events.map((e) => e.memberId).filter((id) => id !== 'system'))]
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, image: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  // Stored model ids are opaque UUIDs after the catalog-uuid migration; resolve
  // them to human display names (alias / static-catalog aware) for the UI.
  const modelLabels = await resolveModelLabels(
    events
      .filter((e) => !(typeof e.actionType === 'string' && e.actionType.startsWith('voice_')))
      .map((e) => {
        const m = parseMeta(e.actionMetadata)
        return (m.model || m.modelUsed || 'unknown') as string
      }),
  )

  const entries: UsageLogEntry[] = events.map((event) => {
    const meta = parseMeta(event.actionMetadata)
    const user = userMap.get(event.memberId)
    const isVoice = typeof event.actionType === 'string' &&
      event.actionType.startsWith('voice_')
    const rawModel = meta.model || meta.modelUsed || 'unknown'
    return {
      id: event.id,
      userId: event.memberId,
      userName: user?.name ?? null,
      userEmail: user?.email ?? event.memberId,
      userImage: user?.image ?? null,
      model: isVoice
        ? voiceLabel(event.actionType)
        : (modelLabels.get(rawModel) ?? rawModel),
      provider: isVoice ? 'elevenlabs' : (meta.provider || 'anthropic'),
      inputTokens: meta.inputTokens || 0,
      outputTokens: meta.outputTokens || 0,
      totalTokens: meta.totalTokens || 0,
      billedUsd: event.billedUsd,
      rawUsd: (meta.rawUsd as number | undefined) ?? (meta.dollarCost as number | undefined) ?? 0,
      durationMs: (meta.durationSeconds ?? 0) * 1000 || meta.durationMs || 0,
      success: meta.success !== false,
      createdAt: event.createdAt.toISOString(),
      actionType: event.actionType,
      metadata: meta as Record<string, unknown>,
    }
  })

  return { entries, total, page, limit }
}

/**
 * Get aggregated usage summary grouped by user + model.
 * Scope-aware: no scope = platform-wide, workspaceId = workspace-scoped.
 */
export async function getUsageSummary(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
  options: { page?: number; limit?: number; excludeInternal?: boolean } = {}
) {
  const since = periodToDate(period)
  const page = Math.max(1, options.page ?? 1)
  const limit = Math.min(Math.max(1, options.limit ?? 25), 1000)
  const excludeInternal = options.excludeInternal ?? false

  const where: any = {
    actionType: {
      in: [
        'ai_proxy_completion',
        'chat_message',
        'voice_minutes_inbound',
        'voice_minutes_outbound',
        'voice_number_setup',
        'voice_number_monthly',
      ],
    },
    createdAt: { gte: since },
  }
  if (scope.workspaceId) where.workspaceId = scope.workspaceId
  if (scope.projectId) where.projectId = scope.projectId
  if (scope.userId) where.memberId = scope.userId

  // When excluding internal users, build the set of internal member ids up
  // front so we can skip their events during aggregation.
  const internalIds = excludeInternal ? await getInternalUserIds() : null

  // Fetch all matching events (for in-memory aggregation)
  const events = await prisma.usageEvent.findMany({
    where,
    select: {
      memberId: true,
      billedUsd: true,
      rawUsd: true,
      actionMetadata: true,
    },
  })

  // Aggregate by userId + model
  const aggregateMap = new Map<string, {
    userId: string
    model: string
    provider: string
    requestCount: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    totalBilledUsd: number
    totalRawUsd: number
    totalDurationMs: number
  }>()

  let countedEvents = 0
  for (const event of events) {
    if (internalIds && internalIds.has(event.memberId)) continue
    countedEvents += 1
    const meta = parseMeta(event.actionMetadata)
    const model = meta.model || meta.modelUsed || 'unknown'
    const key = `${event.memberId}::${model}`
    const existing = aggregateMap.get(key)
    const rawForEvent = event.rawUsd ?? (meta.rawUsd as number | undefined) ?? 0

    if (existing) {
      existing.requestCount += 1
      existing.totalInputTokens += meta.inputTokens || 0
      existing.totalOutputTokens += meta.outputTokens || 0
      existing.totalTokens += meta.totalTokens || 0
      existing.totalBilledUsd += event.billedUsd
      existing.totalRawUsd += rawForEvent
      existing.totalDurationMs += meta.durationMs || 0
    } else {
      aggregateMap.set(key, {
        userId: event.memberId,
        model,
        provider: meta.provider || 'anthropic',
        requestCount: 1,
        totalInputTokens: meta.inputTokens || 0,
        totalOutputTokens: meta.outputTokens || 0,
        totalTokens: meta.totalTokens || 0,
        totalBilledUsd: event.billedUsd,
        totalRawUsd: rawForEvent,
        totalDurationMs: meta.durationMs || 0,
      })
    }
  }

  // Resolve user info
  const userIds = [...new Set([...aggregateMap.values()].map((a) => a.userId).filter((id) => id !== 'system'))]
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, image: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  // Stored model ids are opaque UUIDs after the catalog-uuid migration; resolve
  // them to human display names for the UI (uniqueModels still counts raw ids).
  const modelLabels = await resolveModelLabels(
    [...aggregateMap.values()].map((a) => a.model),
  )

  // Also get tool call counts per user (from ToolCallLog → ChatSession → Project)
  // We aggregate tool calls through the workspace scope if available
  const toolCallWhere: any = { status: 'complete' }
  if (scope.workspaceId) {
    toolCallWhere.chatSession = { project: { workspaceId: scope.workspaceId } }
  }
  if (scope.projectId) {
    toolCallWhere.chatSession = { contextId: scope.projectId }
  }
  if (since) {
    toolCallWhere.createdAt = { gte: since }
  }

  // Get total tool calls at platform or workspace level
  const totalToolCalls = await prisma.toolCallLog.count({ where: toolCallWhere })

  const summaries: UsageSummaryEntry[] = [...aggregateMap.values()]
    .map((agg) => {
      const user = userMap.get(agg.userId)
      return {
        userId: agg.userId,
        userName: user?.name ?? null,
        userEmail: user?.email ?? agg.userId,
        userImage: user?.image ?? null,
        model: modelLabels.get(agg.model) ?? agg.model,
        provider: agg.provider,
        requestCount: agg.requestCount,
        totalInputTokens: agg.totalInputTokens,
        totalOutputTokens: agg.totalOutputTokens,
        totalTokens: agg.totalTokens,
        totalBilledUsd: agg.totalBilledUsd,
        totalRawUsd: agg.totalRawUsd,
        avgDurationMs: agg.requestCount > 0 ? Math.round(agg.totalDurationMs / agg.requestCount) : 0,
      }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)

  // Compute totals across the full (unpaginated) result set.
  const totals = {
    totalRequests: countedEvents,
    totalInputTokens: summaries.reduce((s, e) => s + e.totalInputTokens, 0),
    totalOutputTokens: summaries.reduce((s, e) => s + e.totalOutputTokens, 0),
    totalTokens: summaries.reduce((s, e) => s + e.totalTokens, 0),
    totalBilledUsd: summaries.reduce((s, e) => s + e.totalBilledUsd, 0),
    totalRawUsd: summaries.reduce((s, e) => s + e.totalRawUsd, 0),
    totalToolCalls,
    uniqueUsers: new Set(summaries.map((s) => s.userId)).size,
    uniqueModels: new Set([...aggregateMap.values()].map((a) => a.model)).size,
  }

  // Paginate the aggregated rows (the list can get very long in prod).
  const total = summaries.length
  const paged = summaries.slice((page - 1) * limit, (page - 1) * limit + limit)

  return { summaries: paged, totals, total, page, limit }
}

// ============================================================================
// Chat Analytics
// ============================================================================

/**
 * Get chat analytics - sessions, messages, tool calls.
 */
export async function getChatAnalytics(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d'
) {
  const since = periodToDate(period)

  // Build where clause for chat sessions
  const sessionWhere: any = { createdAt: { gte: since } }
  if (scope.projectId) {
    sessionWhere.contextId = scope.projectId
  } else if (scope.workspaceId) {
    sessionWhere.project = { workspaceId: scope.workspaceId }
  }

  const [sessions, totalMessages, totalToolCalls] = await Promise.all([
    prisma.chatSession.findMany({
      where: sessionWhere,
      select: {
        id: true,
        createdAt: true,
        _count: {
          select: {
            messages: { where: { role: 'user', agent: 'technical' } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.chatMessage.count({
      where: { role: 'user', agent: 'technical', session: sessionWhere },
    }),
    prisma.toolCallLog.count({
      where: { chatSession: sessionWhere },
    }),
  ])

  const totalSessions = sessions.length
  const avgMessagesPerSession =
    totalSessions > 0 ? Math.round((totalMessages / totalSessions) * 10) / 10 : 0

  // Sessions created per day
  const dailySessions = groupByDate(sessions)

  return {
    totalSessions,
    totalMessages,
    totalToolCalls,
    avgMessagesPerSession,
    dailySessions,
  }
}

// ============================================================================
// Project Analytics
// ============================================================================

/**
 * Get project analytics - status distribution, tier breakdown, most active.
 */
export async function getProjectAnalytics(scope: AnalyticsScope = {}) {
  const where = scope.workspaceId ? { workspaceId: scope.workspaceId } : {}

  const projects = await prisma.project.findMany({
    where,
    select: {
      id: true,
      name: true,
      status: true,
      tier: true,
      createdAt: true,
      _count: {
        select: {
          chatSessions: true,
          usageEvents: true,
        },
      },
    },
  })

  // Status distribution
  const byStatus = new Map<string, number>()
  for (const p of projects) {
    byStatus.set(p.status, (byStatus.get(p.status) || 0) + 1)
  }

  // Tier distribution
  const byTier = new Map<string, number>()
  for (const p of projects) {
    byTier.set(p.tier, (byTier.get(p.tier) || 0) + 1)
  }

  // Most active by usage events
  const mostActive = projects
    .map((p) => ({
      id: p.id,
      name: p.name,
      chatSessions: p._count.chatSessions,
      usageEvents: p._count.usageEvents,
    }))
    .sort((a, b) => b.usageEvents - a.usageEvents)
    .slice(0, 10)

  return {
    totalProjects: projects.length,
    byStatus: Object.fromEntries(byStatus),
    byTier: Object.fromEntries(byTier),
    mostActive,
  }
}

// ============================================================================
// Billing Analytics
// ============================================================================

/**
 * Get billing analytics - subscriptions by plan, revenue indicators.
 */
export async function getBillingAnalytics(scope: AnalyticsScope = {}) {
  const where = scope.workspaceId ? { workspaceId: scope.workspaceId } : {}

  const subscriptions = await prisma.subscription.findMany({
    where,
    select: {
      planId: true,
      status: true,
      billingInterval: true,
    },
  })

  // By plan
  const byPlan = new Map<string, number>()
  for (const sub of subscriptions) {
    byPlan.set(sub.planId, (byPlan.get(sub.planId) || 0) + 1)
  }

  // By status
  const byStatus = new Map<string, number>()
  for (const sub of subscriptions) {
    byStatus.set(sub.status, (byStatus.get(sub.status) || 0) + 1)
  }

  // By billing interval
  const byInterval = new Map<string, number>()
  for (const sub of subscriptions) {
    byInterval.set(sub.billingInterval, (byInterval.get(sub.billingInterval) || 0) + 1)
  }

  // Free vs paid ratio (workspaces without active subscriptions)
  const totalWorkspaces = await prisma.workspace.count(
    scope.workspaceId ? { where: { id: scope.workspaceId } } : undefined
  )
  const paidWorkspaces = subscriptions.filter((s) => s.status === 'active').length
  const freeWorkspaces = totalWorkspaces - paidWorkspaces

  return {
    totalSubscriptions: subscriptions.length,
    activeSubscriptions: subscriptions.filter((s) => s.status === 'active').length,
    byPlan: Object.fromEntries(byPlan),
    byStatus: Object.fromEntries(byStatus),
    byInterval: Object.fromEntries(byInterval),
    freeWorkspaces,
    paidWorkspaces,
  }
}

// ============================================================================
// Internal User Exclusion
// ============================================================================

const EXCLUDED_EMAIL_PATTERNS = ['%@test.shogo.ai', '%@shogo.ai', '%@getodin.ai']
const isSqlite = process.env.SHOGO_LOCAL_MODE === 'true'

/**
 * Coerce a value that may be a `bigint` (returned by Prisma `$queryRaw*` for
 * SQLite/Postgres `COUNT(*)` and similar aggregates) into a plain `number`.
 *
 * Hono's `c.json()` calls `JSON.stringify`, which throws on `BigInt`. Raw SQL
 * `CAST(... AS INTEGER)` doesn't help on SQLite — Prisma still returns 64-bit
 * integers as `bigint`. Always run aggregate columns through this before
 * returning them from a service function.
 */
function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'number') return v
  return Number(v)
}

/** Like `toNum` but preserves null/undefined (for nullable averages). */
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'number') return v
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

export function realUserWhere(): Prisma.UserWhereInput {
  return {
    AND: [
      { role: { not: 'super_admin' } },
      ...EXCLUDED_EMAIL_PATTERNS.map(pattern => ({
        NOT: {
          email: {
            contains: pattern.replace('%', ''),
            ...(isSqlite ? {} : { mode: 'insensitive' as const }),
          },
        },
      })),
    ],
  }
}

function realUserEmailNotLike(): string {
  const likeOp = isSqlite ? 'NOT LIKE' : 'NOT ILIKE'
  return EXCLUDED_EMAIL_PATTERNS
    .map(p => `u."email" ${likeOp} '${p}'`)
    .concat([`u."role" != 'super_admin'`])
    .join(' AND ')
}

/**
 * Resolve the set of internal user ids (super admins + Shogo/test domains) so
 * in-memory aggregations (usage summary, workspace activity) can skip them when
 * `excludeInternal` is requested. Inverse of {@link realUserWhere}.
 */
export async function getInternalUserIds(): Promise<Set<string>> {
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        { role: 'super_admin' },
        ...EXCLUDED_EMAIL_PATTERNS.map(pattern => ({
          email: {
            contains: pattern.replace('%', ''),
            ...(isSqlite ? {} : { mode: 'insensitive' as const }),
          },
        })),
      ],
    },
    select: { id: true },
  })
  return new Set(rows.map(r => r.id))
}

// ============================================================================
// User Funnel
// ============================================================================

export interface FunnelResult {
  signups: number
  onboarded: number
  createdProject: number
  sentMessage: number
  engaged: number
  avgMinToFirstProject: number | null
  avgMinToFirstMessage: number | null
}

export async function getUserFunnel(
  period: AnalyticsPeriod = '30d',
  excludeInternal = true
): Promise<FunnelResult> {
  const since = periodToDate(period)
  const filter = excludeInternal ? `AND ${realUserEmailNotLike()}` : ''

  const result = await prisma.$queryRawUnsafe<Record<keyof FunnelResult, unknown>[]>(
    isSqlite
      ? `
    WITH real_users AS (
      SELECT u."id", u."email", u."onboardingCompleted", u."createdAt"
      FROM "users" u
      WHERE u."createdAt" >= ? ${filter}
    ),
    user_projects AS (
      SELECT p."createdBy" AS "userId", MIN(p."createdAt") AS "firstProjectAt"
      FROM "projects" p
      WHERE p."createdBy" IS NOT NULL
      GROUP BY p."createdBy"
    ),
    user_messages AS (
      SELECT cs."contextId" AS "projectId", p."createdBy" AS "userId",
             COUNT(*) AS "msgCount", MIN(cm."createdAt") AS "firstMessageAt"
      FROM "chat_messages" cm
      JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
      JOIN "projects" p ON p."id" = cs."contextId"
      WHERE cm."role" = 'user' AND cm."agent" = 'technical' AND p."createdBy" IS NOT NULL
      GROUP BY cs."contextId", p."createdBy"
    ),
    user_msg_totals AS (
      SELECT "userId", CAST(SUM("msgCount") AS INTEGER) AS "totalMessages",
             MIN("firstMessageAt") AS "firstMessageAt"
      FROM user_messages
      GROUP BY "userId"
    )
    SELECT
      CAST(COUNT(ru."id") AS INTEGER) AS "signups",
      CAST(COUNT(CASE WHEN ru."onboardingCompleted" THEN 1 END) AS INTEGER) AS "onboarded",
      CAST(COUNT(up."userId") AS INTEGER) AS "createdProject",
      CAST(COUNT(CASE WHEN umt."totalMessages" > 0 THEN 1 END) AS INTEGER) AS "sentMessage",
      CAST(COUNT(CASE WHEN umt."totalMessages" >= 5 THEN 1 END) AS INTEGER) AS "engaged",
      ROUND(AVG((julianday(up."firstProjectAt") - julianday(ru."createdAt")) * 1440.0), 1) AS "avgMinToFirstProject",
      ROUND(AVG((julianday(umt."firstMessageAt") - julianday(ru."createdAt")) * 1440.0), 1) AS "avgMinToFirstMessage"
    FROM real_users ru
    LEFT JOIN user_projects up ON up."userId" = ru."id"
    LEFT JOIN user_msg_totals umt ON umt."userId" = ru."id"
  `
      : `
    WITH real_users AS (
      SELECT u."id", u."email", u."onboardingCompleted", u."createdAt"
      FROM "users" u
      WHERE u."createdAt" >= $1 ${filter}
    ),
    user_projects AS (
      SELECT p."createdBy" AS "userId", MIN(p."createdAt") AS "firstProjectAt"
      FROM "projects" p
      WHERE p."createdBy" IS NOT NULL
      GROUP BY p."createdBy"
    ),
    user_messages AS (
      SELECT cs."contextId" AS "projectId", p."createdBy" AS "userId",
             COUNT(*) AS "msgCount", MIN(cm."createdAt") AS "firstMessageAt"
      FROM "chat_messages" cm
      JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
      JOIN "projects" p ON p."id" = cs."contextId"
      WHERE cm."role" = 'user' AND cm."agent" = 'technical' AND p."createdBy" IS NOT NULL
      GROUP BY cs."contextId", p."createdBy"
    ),
    user_msg_totals AS (
      SELECT "userId", SUM("msgCount")::int AS "totalMessages",
             MIN("firstMessageAt") AS "firstMessageAt"
      FROM user_messages
      GROUP BY "userId"
    )
    SELECT
      COUNT(ru."id")::int AS "signups",
      COUNT(CASE WHEN ru."onboardingCompleted" THEN 1 END)::int AS "onboarded",
      COUNT(up."userId")::int AS "createdProject",
      COUNT(CASE WHEN umt."totalMessages" > 0 THEN 1 END)::int AS "sentMessage",
      COUNT(CASE WHEN umt."totalMessages" >= 5 THEN 1 END)::int AS "engaged",
      ROUND(AVG(EXTRACT(EPOCH FROM (up."firstProjectAt" - ru."createdAt")) / 60.0)::numeric, 1)::float AS "avgMinToFirstProject",
      ROUND(AVG(EXTRACT(EPOCH FROM (umt."firstMessageAt" - ru."createdAt")) / 60.0)::numeric, 1)::float AS "avgMinToFirstMessage"
    FROM real_users ru
    LEFT JOIN user_projects up ON up."userId" = ru."id"
    LEFT JOIN user_msg_totals umt ON umt."userId" = ru."id"
  `,
    since
  )

  const row = result[0]
  if (!row) {
    return {
      signups: 0, onboarded: 0, createdProject: 0, sentMessage: 0, engaged: 0,
      avgMinToFirstProject: null, avgMinToFirstMessage: null,
    }
  }
  return {
    signups: toNum(row.signups),
    onboarded: toNum(row.onboarded),
    createdProject: toNum(row.createdProject),
    sentMessage: toNum(row.sentMessage),
    engaged: toNum(row.engaged),
    avgMinToFirstProject: toNumOrNull(row.avgMinToFirstProject),
    avgMinToFirstMessage: toNumOrNull(row.avgMinToFirstMessage),
  }
}

// ============================================================================
// User Activity Table
// ============================================================================

export interface UserActivity {
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

export async function getUserActivityTable(
  period: AnalyticsPeriod = '30d',
  options: { page?: number; limit?: number; sort?: string; excludeInternal?: boolean } = {}
): Promise<{ users: UserActivity[]; total: number; page: number; limit: number }> {
  const since = periodToDate(period)
  const page = options.page ?? 1
  const limit = Math.min(options.limit ?? 20, 100)
  const excludeInternal = options.excludeInternal ?? true

  const userWhere: Prisma.UserWhereInput = {
    createdAt: { gte: since },
    ...(excludeInternal ? realUserWhere() : {}),
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        signupAttribution: { select: { sourceTag: true } },
        sessions: {
          select: { updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        _count: {
          select: {
            members: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where: userWhere }),
  ])

  const userIds = users.map(u => u.id)

  const [projectCounts, messageCounts, sessionCounts, toolCallCounts, usdSums] =
    await Promise.all([
      prisma.project.groupBy({
        by: ['createdBy'],
        where: { createdBy: { in: userIds } },
        _count: true,
      }),
      isSqlite
        ? prisma.$queryRawUnsafe<{ userId: string; count: number }[]>(`
            SELECT p."createdBy" AS "userId", CAST(COUNT(cm."id") AS INTEGER) AS "count"
            FROM "chat_messages" cm
            JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
            JOIN "projects" p ON p."id" = cs."contextId"
            WHERE cm."role" = 'user' AND cm."agent" = 'technical' AND p."createdBy" IN (${userIds.map(() => '?').join(',')})
            GROUP BY p."createdBy"
          `, ...userIds)
        : prisma.$queryRawUnsafe<{ userId: string; count: number }[]>(`
            SELECT p."createdBy" AS "userId", COUNT(cm."id")::int AS "count"
            FROM "chat_messages" cm
            JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
            JOIN "projects" p ON p."id" = cs."contextId"
            WHERE cm."role" = 'user' AND cm."agent" = 'technical' AND p."createdBy" = ANY($1::text[])
            GROUP BY p."createdBy"
          `, userIds),
      isSqlite
        ? prisma.$queryRawUnsafe<{ userId: string; count: number }[]>(`
            SELECT p."createdBy" AS "userId", CAST(COUNT(DISTINCT cs."id") AS INTEGER) AS "count"
            FROM "chat_sessions" cs
            JOIN "projects" p ON p."id" = cs."contextId"
            WHERE p."createdBy" IN (${userIds.map(() => '?').join(',')})
            GROUP BY p."createdBy"
          `, ...userIds)
        : prisma.$queryRawUnsafe<{ userId: string; count: number }[]>(`
            SELECT p."createdBy" AS "userId", COUNT(DISTINCT cs."id")::int AS "count"
            FROM "chat_sessions" cs
            JOIN "projects" p ON p."id" = cs."contextId"
            WHERE p."createdBy" = ANY($1::text[])
            GROUP BY p."createdBy"
          `, userIds),
      isSqlite
        ? prisma.$queryRawUnsafe<{ userId: string; count: number }[]>(`
            SELECT p."createdBy" AS "userId", CAST(COUNT(tcl."id") AS INTEGER) AS "count"
            FROM "tool_call_logs" tcl
            JOIN "chat_sessions" cs ON cs."id" = tcl."chatSessionId"
            JOIN "projects" p ON p."id" = cs."contextId"
            WHERE p."createdBy" IN (${userIds.map(() => '?').join(',')})
            GROUP BY p."createdBy"
          `, ...userIds)
        : prisma.$queryRawUnsafe<{ userId: string; count: number }[]>(`
            SELECT p."createdBy" AS "userId", COUNT(tcl."id")::int AS "count"
            FROM "tool_call_logs" tcl
            JOIN "chat_sessions" cs ON cs."id" = tcl."chatSessionId"
            JOIN "projects" p ON p."id" = cs."contextId"
            WHERE p."createdBy" = ANY($1::text[])
            GROUP BY p."createdBy"
          `, userIds),
      prisma.usageEvent.groupBy({
        by: ['memberId'],
        where: { memberId: { in: userIds } },
        _sum: { billedUsd: true },
      }),
    ])

  const projectMap = new Map(projectCounts.map(r => [r.createdBy!, toNum(r._count)]))
  const messageMap = new Map(messageCounts.map(r => [r.userId, toNum(r.count)]))
  const sessionMap = new Map(sessionCounts.map(r => [r.userId, toNum(r.count)]))
  const toolCallMap = new Map(toolCallCounts.map(r => [r.userId, toNum(r.count)]))
  const usdMap = new Map(usdSums.map(r => [r.memberId, Number(r._sum.billedUsd ?? 0)]))

  const result: UserActivity[] = users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    sourceTag: (u as any).signupAttribution?.sourceTag ?? null,
    signupAt: u.createdAt.toISOString(),
    lastActiveAt: u.sessions[0]?.updatedAt?.toISOString() ?? null,
    projects: projectMap.get(u.id) ?? 0,
    messages: messageMap.get(u.id) ?? 0,
    sessions: sessionMap.get(u.id) ?? 0,
    toolCalls: toolCallMap.get(u.id) ?? 0,
    spendUsd: usdMap.get(u.id) ?? 0,
  }))

  return { users: result, total, page, limit }
}

// ============================================================================
// Tool Call Analytics
// ============================================================================

export interface ToolCallStat {
  toolName: string
  total: number
  errors: number
  successRate: number
  avgDurationMs: number
}

export interface ToolCallAnalyticsResult {
  tools: ToolCallStat[]
  totals: { totalCalls: number; totalErrors: number; successRate: number }
  daily: { date: string; calls: number; errors: number; successRate: number }[]
}

/**
 * Decide whether a tool call failed. Going forward the writer records
 * `status: 'error'` directly; for historical rows (always written as
 * 'complete') we fall back to inspecting the stored `result` JSON for common
 * error markers.
 */
function toolCallFailed(status: string, result: unknown): boolean {
  if (status === 'error') return true
  const r = parseMeta(result)
  if (r && typeof r === 'object') {
    if (r.success === false) return true
    if (r.isError === true) return true
    if (r.error != null && r.error !== false) return true
    if (typeof r.state === 'string' && r.state.toLowerCase() === 'error') return true
    if (typeof r.text === 'string' && /^\s*error\b/i.test(r.text)) return true
  }
  if (typeof result === 'string' && /^\s*error\b/i.test(result)) return true
  return false
}

/**
 * Tool-call usage and success-rate analytics. Per-tool counts + success rate,
 * overall totals, and a zero-filled daily {calls, errors, successRate} series.
 * Scope-aware via the chat session → project relation.
 */
export async function getToolCallAnalytics(
  scope: AnalyticsScope = {},
  period: AnalyticsPeriod = '30d',
  options: { excludeInternal?: boolean } = {},
): Promise<ToolCallAnalyticsResult> {
  const { from, to } = periodToWindow(period)

  const where: any = { createdAt: { gte: from, lt: to } }
  if (scope.projectId) {
    where.chatSession = { contextId: scope.projectId }
  } else if (scope.workspaceId) {
    where.chatSession = { project: { workspaceId: scope.workspaceId } }
  }
  if (options.excludeInternal) {
    const internal = await getInternalUserIds()
    if (internal.size > 0) {
      const existing = where.chatSession ?? {}
      where.chatSession = {
        ...existing,
        project: { ...(existing.project ?? {}), createdBy: { notIn: [...internal] } },
      }
    }
  }

  const rows = await prisma.toolCallLog.findMany({
    where,
    select: { toolName: true, status: true, result: true, duration: true, createdAt: true },
  })

  const perTool = new Map<string, { total: number; errors: number; durSum: number; durCount: number }>()
  const perDay = new Map<string, { calls: number; errors: number }>()
  let totalCalls = 0
  let totalErrors = 0

  for (const r of rows) {
    const failed = toolCallFailed(r.status, r.result)
    totalCalls += 1
    if (failed) totalErrors += 1

    const t = perTool.get(r.toolName) ?? { total: 0, errors: 0, durSum: 0, durCount: 0 }
    t.total += 1
    if (failed) t.errors += 1
    if (typeof r.duration === 'number') { t.durSum += r.duration; t.durCount += 1 }
    perTool.set(r.toolName, t)

    const day = isoDay(r.createdAt)
    const d = perDay.get(day) ?? { calls: 0, errors: 0 }
    d.calls += 1
    if (failed) d.errors += 1
    perDay.set(day, d)
  }

  const tools: ToolCallStat[] = [...perTool.entries()]
    .map(([toolName, s]) => ({
      toolName,
      total: s.total,
      errors: s.errors,
      successRate: s.total > 0 ? ((s.total - s.errors) / s.total) * 100 : 100,
      avgDurationMs: s.durCount > 0 ? Math.round(s.durSum / s.durCount) : 0,
    }))
    .sort((a, b) => b.total - a.total)

  const daily: { date: string; calls: number; errors: number; successRate: number }[] = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const last = new Date(to)
  last.setUTCHours(0, 0, 0, 0)
  while (cursor <= last) {
    const key = isoDay(cursor)
    const d = perDay.get(key)
    const calls = d?.calls ?? 0
    const errors = d?.errors ?? 0
    daily.push({
      date: key,
      calls,
      errors,
      successRate: calls > 0 ? ((calls - errors) / calls) * 100 : 100,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return {
    tools,
    totals: {
      totalCalls,
      totalErrors,
      successRate: totalCalls > 0 ? ((totalCalls - totalErrors) / totalCalls) * 100 : 100,
    },
    daily,
  }
}

// ============================================================================
// Workspace Activity Table
// ============================================================================

export interface WorkspaceActivity {
  workspaceId: string
  name: string
  projects: number
  members: number
  messages: number
  toolCalls: number
  spendUsd: number
}

/**
 * Per-workspace activity table ranked by period spend and paginated. Heavy
 * per-workspace joins (messages, tool calls) only run for the current page.
 */
export async function getWorkspaceActivityTable(
  period: AnalyticsPeriod = '30d',
  options: { page?: number; limit?: number; excludeInternal?: boolean } = {},
): Promise<{ workspaces: WorkspaceActivity[]; total: number; page: number; limit: number }> {
  const since = periodToDate(period)
  const page = Math.max(1, options.page ?? 1)
  const limit = Math.min(Math.max(1, options.limit ?? 20), 100)
  const excludeInternal = options.excludeInternal ?? true

  let workspaces = await prisma.workspace.findMany({ select: { id: true, name: true } })

  if (excludeInternal) {
    const internal = await getInternalUserIds()
    const members = await prisma.member.findMany({
      where: { workspaceId: { not: null } },
      select: { workspaceId: true, userId: true },
    })
    const realWs = new Set<string>()
    for (const m of members) {
      if (m.workspaceId && !internal.has(m.userId)) realWs.add(m.workspaceId)
    }
    workspaces = workspaces.filter((w) => realWs.has(w.id))
  }

  // Spend over the period is the ranking key.
  const spendRows = await prisma.usageEvent.groupBy({
    by: ['workspaceId'],
    where: { createdAt: { gte: since } },
    _sum: { billedUsd: true },
  })
  const spendMap = new Map(spendRows.map((r) => [r.workspaceId, r._sum.billedUsd ?? 0]))

  const ranked = workspaces
    .map((w) => ({ id: w.id, name: w.name, spendUsd: spendMap.get(w.id) ?? 0 }))
    .sort((a, b) => b.spendUsd - a.spendUsd)

  const total = ranked.length
  const pageRows = ranked.slice((page - 1) * limit, (page - 1) * limit + limit)
  const ids = pageRows.map((w) => w.id)

  if (ids.length === 0) {
    return { workspaces: [], total, page, limit }
  }

  const [projectCounts, memberCounts, messageRows, toolRows] = await Promise.all([
    prisma.project.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: ids } }, _count: true }),
    prisma.member.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: ids } }, _count: true }),
    isSqlite
      ? prisma.$queryRawUnsafe<{ wid: string; count: number }[]>(`
          SELECT p."workspaceId" AS "wid", CAST(COUNT(cm."id") AS INTEGER) AS "count"
          FROM "chat_messages" cm
          JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
          JOIN "projects" p ON p."id" = cs."contextId"
          WHERE cm."role" = 'user' AND cm."agent" = 'technical'
            AND cm."createdAt" >= ? AND p."workspaceId" IN (${ids.map(() => '?').join(',')})
          GROUP BY p."workspaceId"
        `, since, ...ids)
      : prisma.$queryRawUnsafe<{ wid: string; count: number }[]>(`
          SELECT p."workspaceId" AS "wid", COUNT(cm."id")::int AS "count"
          FROM "chat_messages" cm
          JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
          JOIN "projects" p ON p."id" = cs."contextId"
          WHERE cm."role" = 'user' AND cm."agent" = 'technical'
            AND cm."createdAt" >= $1 AND p."workspaceId" = ANY($2::text[])
          GROUP BY p."workspaceId"
        `, since, ids),
    isSqlite
      ? prisma.$queryRawUnsafe<{ wid: string; count: number }[]>(`
          SELECT p."workspaceId" AS "wid", CAST(COUNT(tcl."id") AS INTEGER) AS "count"
          FROM "tool_call_logs" tcl
          JOIN "chat_sessions" cs ON cs."id" = tcl."chatSessionId"
          JOIN "projects" p ON p."id" = cs."contextId"
          WHERE tcl."createdAt" >= ? AND p."workspaceId" IN (${ids.map(() => '?').join(',')})
          GROUP BY p."workspaceId"
        `, since, ...ids)
      : prisma.$queryRawUnsafe<{ wid: string; count: number }[]>(`
          SELECT p."workspaceId" AS "wid", COUNT(tcl."id")::int AS "count"
          FROM "tool_call_logs" tcl
          JOIN "chat_sessions" cs ON cs."id" = tcl."chatSessionId"
          JOIN "projects" p ON p."id" = cs."contextId"
          WHERE tcl."createdAt" >= $1 AND p."workspaceId" = ANY($2::text[])
          GROUP BY p."workspaceId"
        `, since, ids),
  ])

  const projectMap = new Map(projectCounts.map((r) => [r.workspaceId!, toNum(r._count)]))
  const memberMap = new Map(memberCounts.map((r) => [r.workspaceId!, toNum(r._count)]))
  const messageMap = new Map(messageRows.map((r) => [r.wid, toNum(r.count)]))
  const toolMap = new Map(toolRows.map((r) => [r.wid, toNum(r.count)]))

  const result: WorkspaceActivity[] = pageRows.map((w) => ({
    workspaceId: w.id,
    name: w.name,
    projects: projectMap.get(w.id) ?? 0,
    members: memberMap.get(w.id) ?? 0,
    messages: messageMap.get(w.id) ?? 0,
    toolCalls: toolMap.get(w.id) ?? 0,
    spendUsd: w.spendUsd,
  }))

  return { workspaces: result, total, page, limit }
}

// ============================================================================
// Template Engagement
// ============================================================================

export interface TemplateStats {
  templateId: string
  projects: number
  avgMessages: number
  totalToolCalls: number
  engagementRate: number
}

export async function getTemplateEngagement(
  excludeInternal = true
): Promise<{ templates: TemplateStats[] }> {
  const filter = excludeInternal ? `AND ${realUserEmailNotLike()}` : ''

  const rows = await prisma.$queryRawUnsafe<{
    templateId: string
    projects: number
    avgMessages: number
    totalToolCalls: number
    engagedUsers: number
    totalUsers: number
  }[]>(
    // Template provenance moved from `Project.templateId` to
    // `MarketplaceInstall.listingId → MarketplaceListing.slug` during
    // the templates → marketplace consolidation. The output `templateId`
    // field is preserved (analytics dashboards still read it under that
    // key) but is now sourced from the listing slug.
    isSqlite
      ? `
    WITH template_projects AS (
      SELECT ml."slug" AS "templateId", p."id" AS "projectId", p."createdBy"
      FROM "projects" p
      JOIN "users" u ON u."id" = p."createdBy"
      JOIN "marketplace_installs" mi ON mi."projectId" = p."id"
      JOIN "marketplace_listings" ml ON ml."id" = mi."listingId"
      WHERE 1=1 ${filter}
    ),
    project_msgs AS (
      SELECT tp."templateId", tp."projectId", tp."createdBy",
             CAST(COUNT(cm."id") AS INTEGER) AS "msgCount"
      FROM template_projects tp
      LEFT JOIN "chat_sessions" cs ON cs."contextId" = tp."projectId"
      LEFT JOIN "chat_messages" cm ON cm."sessionId" = cs."id" AND cm."role" = 'user' AND cm."agent" = 'technical'
      GROUP BY tp."templateId", tp."projectId", tp."createdBy"
    ),
    project_tools AS (
      SELECT tp."templateId", CAST(COUNT(tcl."id") AS INTEGER) AS "toolCalls"
      FROM template_projects tp
      LEFT JOIN "chat_sessions" cs ON cs."contextId" = tp."projectId"
      LEFT JOIN "tool_call_logs" tcl ON tcl."chatSessionId" = cs."id"
      GROUP BY tp."templateId"
    )
    SELECT
      pm."templateId" AS "templateId",
      CAST(COUNT(DISTINCT pm."projectId") AS INTEGER) AS "projects",
      ROUND(AVG(pm."msgCount"), 1) AS "avgMessages",
      CAST(COALESCE(MAX(pt."toolCalls"), 0) AS INTEGER) AS "totalToolCalls",
      CAST(COUNT(DISTINCT CASE WHEN pm."msgCount" >= 2 THEN pm."createdBy" END) AS INTEGER) AS "engagedUsers",
      CAST(COUNT(DISTINCT pm."createdBy") AS INTEGER) AS "totalUsers"
    FROM project_msgs pm
    LEFT JOIN project_tools pt ON pt."templateId" = pm."templateId"
    GROUP BY pm."templateId"
    ORDER BY "projects" DESC
  `
      : `
    WITH template_projects AS (
      SELECT ml."slug" AS "templateId", p."id" AS "projectId", p."createdBy"
      FROM "projects" p
      JOIN "users" u ON u."id" = p."createdBy"
      JOIN "marketplace_installs" mi ON mi."projectId" = p."id"
      JOIN "marketplace_listings" ml ON ml."id" = mi."listingId"
      WHERE 1=1 ${filter}
    ),
    project_msgs AS (
      SELECT tp."templateId", tp."projectId", tp."createdBy",
             COUNT(cm."id")::int AS "msgCount"
      FROM template_projects tp
      LEFT JOIN "chat_sessions" cs ON cs."contextId" = tp."projectId"
      LEFT JOIN "chat_messages" cm ON cm."sessionId" = cs."id" AND cm."role" = 'user' AND cm."agent" = 'technical'
      GROUP BY tp."templateId", tp."projectId", tp."createdBy"
    ),
    project_tools AS (
      SELECT tp."templateId", COUNT(tcl."id")::int AS "toolCalls"
      FROM template_projects tp
      LEFT JOIN "chat_sessions" cs ON cs."contextId" = tp."projectId"
      LEFT JOIN "tool_call_logs" tcl ON tcl."chatSessionId" = cs."id"
      GROUP BY tp."templateId"
    )
    SELECT
      pm."templateId" AS "templateId",
      COUNT(DISTINCT pm."projectId")::int AS "projects",
      ROUND(AVG(pm."msgCount")::numeric, 1)::float AS "avgMessages",
      COALESCE(MAX(pt."toolCalls"), 0)::int AS "totalToolCalls",
      COUNT(DISTINCT CASE WHEN pm."msgCount" >= 2 THEN pm."createdBy" END)::int AS "engagedUsers",
      COUNT(DISTINCT pm."createdBy")::int AS "totalUsers"
    FROM project_msgs pm
    LEFT JOIN project_tools pt ON pt."templateId" = pm."templateId"
    GROUP BY pm."templateId"
    ORDER BY "projects" DESC
  `
  )

  return {
    templates: rows.map(r => {
      const totalUsers = toNum(r.totalUsers)
      const engagedUsers = toNum(r.engagedUsers)
      return {
        templateId: r.templateId,
        projects: toNum(r.projects),
        avgMessages: toNum(r.avgMessages),
        totalToolCalls: toNum(r.totalToolCalls),
        engagementRate: totalUsers > 0
          ? Math.round((engagedUsers / totalUsers) * 100)
          : 0,
      }
    }),
  }
}

// ============================================================================
// Chat Conversations (for AI Digest)
// ============================================================================

export interface ConversationThread {
  userName: string | null
  projectName: string
  templateId: string | null
  messages: { role: string; content: string; sentAt: string }[]
}

const ASSISTANT_TRUNCATE_LENGTH = 1000

export async function getChatConversations(
  since: Date,
  excludeInternal = true
): Promise<{ conversations: ConversationThread[] }> {
  const filter = excludeInternal ? `AND ${realUserEmailNotLike()}` : ''

  const rows = await prisma.$queryRawUnsafe<{
    sessionId: string
    userName: string | null
    projectName: string
    templateId: string | null
    role: string
    content: string
    sentAt: Date
  }[]>(
    // Template id (legacy field name, retained for digest formatting) is
    // pulled from the marketplace listing slug via a LEFT JOIN — projects
    // that pre-date the marketplace install (or that were never sourced
    // from a listing) simply have a NULL templateId.
    isSqlite
      ? `
    SELECT
      cs."id" AS "sessionId",
      u."name" AS "userName",
      p."name" AS "projectName",
      ml."slug" AS "templateId",
      cm."role",
      CASE
        WHEN cm."role" = 'assistant' AND LENGTH(cm."content") > ${ASSISTANT_TRUNCATE_LENGTH}
        THEN substr(cm."content", -${ASSISTANT_TRUNCATE_LENGTH})
        ELSE cm."content"
      END AS "content",
      cm."createdAt" AS "sentAt"
    FROM "chat_messages" cm
    JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
    JOIN "projects" p ON p."id" = cs."contextId"
    JOIN "users" u ON u."id" = p."createdBy"
    LEFT JOIN "marketplace_installs" mi ON mi."projectId" = p."id"
    LEFT JOIN "marketplace_listings" ml ON ml."id" = mi."listingId"
    WHERE cm."createdAt" >= ? AND cm."agent" = 'technical' ${filter}
    ORDER BY cs."id", cm."createdAt" ASC
  `
      : `
    SELECT
      cs."id" AS "sessionId",
      u."name" AS "userName",
      p."name" AS "projectName",
      ml."slug" AS "templateId",
      cm."role",
      CASE
        WHEN cm."role" = 'assistant' AND LENGTH(cm."content") > ${ASSISTANT_TRUNCATE_LENGTH}
        THEN RIGHT(cm."content", ${ASSISTANT_TRUNCATE_LENGTH})
        ELSE cm."content"
      END AS "content",
      cm."createdAt" AS "sentAt"
    FROM "chat_messages" cm
    JOIN "chat_sessions" cs ON cs."id" = cm."sessionId"
    JOIN "projects" p ON p."id" = cs."contextId"
    JOIN "users" u ON u."id" = p."createdBy"
    LEFT JOIN "marketplace_installs" mi ON mi."projectId" = p."id"
    LEFT JOIN "marketplace_listings" ml ON ml."id" = mi."listingId"
    WHERE cm."createdAt" >= $1 AND cm."agent" = 'technical' ${filter}
    ORDER BY cs."id", cm."createdAt" ASC
  `,
    since
  )

  const grouped = new Map<string, ConversationThread>()
  for (const row of rows) {
    if (!grouped.has(row.sessionId)) {
      grouped.set(row.sessionId, {
        userName: row.userName,
        projectName: row.projectName,
        templateId: row.templateId,
        messages: [],
      })
    }
    grouped.get(row.sessionId)!.messages.push({
      role: row.role,
      content: row.content,
      sentAt: row.sentAt.toISOString(),
    })
  }

  return { conversations: Array.from(grouped.values()) }
}

// ============================================================================
// Source Breakdown
// ============================================================================

export interface SourceBreakdownEntry {
  tag: string
  count: number
  projectRate: number
  messageRate: number
}

export async function getSourceBreakdown(
  period: AnalyticsPeriod = '30d',
  excludeInternal = true
): Promise<{ sources: SourceBreakdownEntry[] }> {
  const since = periodToDate(period)
  const filter = excludeInternal ? `AND ${realUserEmailNotLike()}` : ''

  const rows = await prisma.$queryRawUnsafe<{
    tag: string
    count: number
    withProject: number
    withMessage: number
  }[]>(
    isSqlite
      ? `
    SELECT
      COALESCE(sa."sourceTag", 'unknown') AS "tag",
      CAST(COUNT(DISTINCT u."id") AS INTEGER) AS "count",
      CAST(COUNT(DISTINCT CASE WHEN p."id" IS NOT NULL THEN u."id" END) AS INTEGER) AS "withProject",
      CAST(COUNT(DISTINCT CASE WHEN cm."id" IS NOT NULL THEN u."id" END) AS INTEGER) AS "withMessage"
    FROM "users" u
    LEFT JOIN "signup_attributions" sa ON sa."userId" = u."id"
    LEFT JOIN "projects" p ON p."createdBy" = u."id"
    LEFT JOIN "chat_sessions" cs ON cs."contextId" = p."id"
    LEFT JOIN "chat_messages" cm ON cm."sessionId" = cs."id" AND cm."role" = 'user' AND cm."agent" = 'technical'
    WHERE u."createdAt" >= ? ${filter}
    GROUP BY COALESCE(sa."sourceTag", 'unknown')
    ORDER BY "count" DESC
  `
      : `
    SELECT
      COALESCE(sa."sourceTag", 'unknown') AS "tag",
      COUNT(DISTINCT u."id")::int AS "count",
      COUNT(DISTINCT CASE WHEN p."id" IS NOT NULL THEN u."id" END)::int AS "withProject",
      COUNT(DISTINCT CASE WHEN cm."id" IS NOT NULL THEN u."id" END)::int AS "withMessage"
    FROM "users" u
    LEFT JOIN "signup_attributions" sa ON sa."userId" = u."id"
    LEFT JOIN "projects" p ON p."createdBy" = u."id"
    LEFT JOIN "chat_sessions" cs ON cs."contextId" = p."id"
    LEFT JOIN "chat_messages" cm ON cm."sessionId" = cs."id" AND cm."role" = 'user' AND cm."agent" = 'technical'
    WHERE u."createdAt" >= $1 ${filter}
    GROUP BY COALESCE(sa."sourceTag", 'unknown')
    ORDER BY "count" DESC
  `,
    since
  )

  return {
    sources: rows.map(r => {
      const count = toNum(r.count)
      const withProject = toNum(r.withProject)
      const withMessage = toNum(r.withMessage)
      return {
        tag: r.tag,
        count,
        projectRate: count > 0 ? Math.round((withProject / count) * 100) : 0,
        messageRate: count > 0 ? Math.round((withMessage / count) * 100) : 0,
      }
    }),
  }
}

// ============================================================================
// Source Tag Derivation
// ============================================================================

export function deriveSourceTag(data: {
  utmSource?: string | null
  utmMedium?: string | null
  referrer?: string | null
  method?: string | null
}): string {
  const src = data.utmSource?.toLowerCase()
  const med = data.utmMedium?.toLowerCase()

  if (src && med === 'cpc') {
    return `${src}-ads`
  }
  if (src) {
    return src
  }
  if (data.referrer) {
    try {
      const host = new URL(data.referrer).hostname.replace('www.', '')
      if (host.includes('google')) return 'organic:google'
      if (host.includes('bing')) return 'organic:bing'
      return `referral:${host}`
    } catch {
      return 'referral'
    }
  }
  if (data.method === 'google') return 'google-oauth'
  return 'direct'
}

// ============================================================================
// Creator Stats (admin: marketplace metrics + per-creator platform usage)
// ============================================================================

export interface CreatorStat {
  userId: string
  displayName: string
  name: string | null
  email: string
  creatorTier: string
  reputationScore: number
  verified: boolean
  totalAgentsPublished: number
  totalInstalls: number
  averageAgentRating: number
  totalVersionsShipped: number
  followerCount: number
  /** Lifetime marketplace earnings, in USD (converted from cents). */
  totalEarningsUsd: number
  pendingPayoutUsd: number
  totalPaidOutUsd: number
  /** Lifetime Shogo platform spend by this creator's account, in USD. */
  spendUsd: number
}

/**
 * Admin creator stats: every marketplace creator with their denormalized
 * marketplace metrics joined to their lifetime platform usage spend.
 *
 * Platform spend is attributed by walking `CreatorProfile.userId -> Member ->
 * UsageEvent.memberId` and summing `billedUsd`, since usage is metered per
 * workspace member, not per creator.
 */
export async function getCreatorStats(): Promise<CreatorStat[]> {
  const creators = await prisma.creatorProfile.findMany({
    orderBy: { totalInstalls: 'desc' },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  })

  if (creators.length === 0) return []

  const userIds = creators.map((c) => c.userId)

  // Map each member row owned by a creator back to its creator userId, so we
  // can attribute usage_events (keyed by memberId) to the right creator.
  const members = await prisma.member.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, userId: true },
  })
  const memberToUser = new Map<string, string>(
    members.map((m) => [m.id, m.userId])
  )
  const memberIds = members.map((m) => m.id)

  const spendByUser = new Map<string, number>()
  if (memberIds.length > 0) {
    const events = await prisma.usageEvent.findMany({
      where: { memberId: { in: memberIds } },
      select: { memberId: true, billedUsd: true },
    })
    for (const ev of events) {
      const uid = memberToUser.get(ev.memberId)
      if (!uid) continue
      spendByUser.set(uid, (spendByUser.get(uid) ?? 0) + (ev.billedUsd ?? 0))
    }
  }

  return creators.map((c) => ({
    userId: c.userId,
    displayName: c.displayName,
    name: c.user?.name ?? null,
    email: c.user?.email ?? '',
    creatorTier: String(c.creatorTier),
    reputationScore: c.reputationScore,
    verified: c.verified,
    totalAgentsPublished: c.totalAgentsPublished,
    totalInstalls: c.totalInstalls,
    averageAgentRating: c.averageAgentRating,
    totalVersionsShipped: c.totalVersionsShipped,
    followerCount: c.followerCount,
    totalEarningsUsd: c.totalEarningsInCents / 100,
    pendingPayoutUsd: c.pendingPayoutInCents / 100,
    totalPaidOutUsd: c.totalPaidOutInCents / 100,
    spendUsd: spendByUser.get(c.userId) ?? 0,
  }))
}

/** One published marketplace listing, summarized for the creator profile. */
export interface CreatorListingSummary {
  id: string
  title: string
  slug: string
  status: string
  pricingModel: string
  installCount: number
  averageRating: number
  reviewCount: number
  currentVersion: string
  publishedAt: string | null
}

/**
 * Affiliate-program 360 for a creator who is also an affiliate. Null when the
 * creator never enrolled in the affiliate program.
 */
export interface CreatorAffiliateSummary {
  code: string
  status: string
  /** Per-affiliate L1 commission override in basis points (null = tier rate). */
  commissionRateBps: number | null
  /** Per-creator content-CPM override in cents/1k views (null = platform CPM). */
  contentCpmCents: number | null
  totalEarningsUsd: number
  pendingPayoutUsd: number
  totalPaidOutUsd: number
  /** Users last-click-attributed to this affiliate. */
  referralCount: number
  /** Direct downline affiliates (children in the upline tree). */
  downlineCount: number
  /** Lifetime commission split by earning channel, in USD. */
  referralEarningsUsd: number
  contentEarningsUsd: number
}

/** Full per-creator profile: stats + published agents + affiliate 360. */
export interface CreatorProfileDetail extends CreatorStat {
  bio: string | null
  avatarUrl: string | null
  websiteUrl: string | null
  createdAt: string
  badges: { badgeType: string; earnedAt: string }[]
  listings: CreatorListingSummary[]
  affiliate: CreatorAffiliateSummary | null
}

/**
 * Admin per-creator profile. Joins the creator's marketplace profile, their
 * published listings, lifetime platform spend (the same Member -> UsageEvent
 * walk as getCreatorStats), and — when the creator also enrolled as an
 * affiliate — their affiliate/commission summary. Returns null when no
 * CreatorProfile exists for `userId`.
 */
export async function getCreatorProfileDetail(
  userId: string,
): Promise<CreatorProfileDetail | null> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { userId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      badges: { select: { badgeType: true, earnedAt: true }, orderBy: { earnedAt: 'desc' } },
      listings: {
        orderBy: { installCount: 'desc' },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          pricingModel: true,
          installCount: true,
          averageRating: true,
          reviewCount: true,
          currentVersion: true,
          publishedAt: true,
        },
      },
    },
  })
  if (!creator) return null

  // Lifetime platform spend: usage is metered per workspace member, so walk
  // this creator's Member rows back to their UsageEvents and sum billedUsd.
  const members = await prisma.member.findMany({ where: { userId }, select: { id: true } })
  const memberIds = members.map((m) => m.id)
  let spendUsd = 0
  if (memberIds.length > 0) {
    const events = await prisma.usageEvent.findMany({
      where: { memberId: { in: memberIds } },
      select: { billedUsd: true },
    })
    spendUsd = events.reduce((sum, ev) => sum + (ev.billedUsd ?? 0), 0)
  }

  // Affiliate 360 — nullable; not every creator enrolled in the program.
  const affiliate = await prisma.affiliate.findUnique({
    where: { userId },
    include: {
      _count: { select: { attributions: true, children: true } },
      commissions: { select: { source: true, amountCents: true } },
    },
  })

  let affiliateSummary: CreatorAffiliateSummary | null = null
  if (affiliate) {
    let referralCents = 0
    let contentCents = 0
    for (const com of affiliate.commissions) {
      if (String(com.source) === 'content') contentCents += com.amountCents
      else referralCents += com.amountCents
    }
    affiliateSummary = {
      code: affiliate.code,
      status: String(affiliate.status),
      commissionRateBps: affiliate.commissionRateBps,
      contentCpmCents: affiliate.contentCpmCents,
      totalEarningsUsd: affiliate.totalEarningsCents / 100,
      pendingPayoutUsd: affiliate.pendingPayoutCents / 100,
      totalPaidOutUsd: affiliate.totalPaidOutCents / 100,
      referralCount: affiliate._count.attributions,
      downlineCount: affiliate._count.children,
      referralEarningsUsd: referralCents / 100,
      contentEarningsUsd: contentCents / 100,
    }
  }

  return {
    userId: creator.userId,
    displayName: creator.displayName,
    name: creator.user?.name ?? null,
    email: creator.user?.email ?? '',
    creatorTier: String(creator.creatorTier),
    reputationScore: creator.reputationScore,
    verified: creator.verified,
    totalAgentsPublished: creator.totalAgentsPublished,
    totalInstalls: creator.totalInstalls,
    averageAgentRating: creator.averageAgentRating,
    totalVersionsShipped: creator.totalVersionsShipped,
    followerCount: creator.followerCount,
    totalEarningsUsd: creator.totalEarningsInCents / 100,
    pendingPayoutUsd: creator.pendingPayoutInCents / 100,
    totalPaidOutUsd: creator.totalPaidOutInCents / 100,
    spendUsd,
    bio: creator.bio,
    avatarUrl: creator.avatarUrl,
    websiteUrl: creator.websiteUrl,
    createdAt: creator.createdAt.toISOString(),
    badges: creator.badges.map((b) => ({
      badgeType: String(b.badgeType),
      earnedAt: b.earnedAt.toISOString(),
    })),
    listings: creator.listings.map((l) => ({
      id: l.id,
      title: l.title,
      slug: l.slug,
      status: String(l.status),
      pricingModel: String(l.pricingModel),
      installCount: l.installCount,
      averageRating: l.averageRating,
      reviewCount: l.reviewCount,
      currentVersion: l.currentVersion,
      publishedAt: l.publishedAt ? l.publishedAt.toISOString() : null,
    })),
    affiliate: affiliateSummary,
  }
}

