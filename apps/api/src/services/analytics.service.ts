/**
 * Analytics Service - Scope-based analytics for platform, workspace, and project levels
 *
 * Every function accepts an optional AnalyticsScope so the same logic serves:
 * - Platform-wide analytics (no scope, super admin only)
 * - Workspace-level analytics (scope = { workspaceId })
 * - Project-level analytics (scope = { workspaceId, projectId })
 */

import { prisma } from '../lib/prisma'

// ============================================================================
// Types
// ============================================================================

export interface AnalyticsScope {
  workspaceId?: string
  projectId?: string
}

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '1y'

interface TimeSeriesPoint {
  date: string
  count: number
}

// ============================================================================
// Helpers
// ============================================================================

function periodToDate(period: AnalyticsPeriod): Date {
  const now = new Date()
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case '90d':
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    case '1y':
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
  }
}

/**
 * Build Prisma where clause fragments from scope.
 * Returns an object that can be spread into a where clause.
 */
function scopeWhere(scope: AnalyticsScope) {
  return {
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
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
 */
export async function getOverviewStats(scope: AnalyticsScope = {}) {
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
        where: { session: { contextId: scope.projectId } },
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
// Usage Analytics
// ============================================================================

/**
 * Get usage/credit analytics - consumption by action type, top consumers.
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
      creditCost: true,
      creditSource: true,
      memberId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  // Aggregate by action type
  const byActionType = new Map<string, { count: number; totalCredits: number }>()
  for (const event of events) {
    const existing = byActionType.get(event.actionType) || { count: 0, totalCredits: 0 }
    existing.count += 1
    existing.totalCredits += event.creditCost
    byActionType.set(event.actionType, existing)
  }

  // Aggregate by credit source
  const byCreditSource = new Map<string, number>()
  for (const event of events) {
    byCreditSource.set(
      event.creditSource,
      (byCreditSource.get(event.creditSource) || 0) + event.creditCost
    )
  }

  // Top consumers by member
  const byMember = new Map<string, number>()
  for (const event of events) {
    byMember.set(event.memberId, (byMember.get(event.memberId) || 0) + event.creditCost)
  }
  const topConsumers = Array.from(byMember.entries())
    .map(([memberId, totalCredits]) => ({ memberId, totalCredits }))
    .sort((a, b) => b.totalCredits - a.totalCredits)
    .slice(0, 10)

  // Daily usage time series
  const dailyUsage = groupByDate(events)

  // Total credits consumed
  const totalCreditsConsumed = events.reduce((sum, e) => sum + e.creditCost, 0)

  return {
    totalEvents: events.length,
    totalCreditsConsumed,
    byActionType: Object.fromEntries(byActionType),
    byCreditSource: Object.fromEntries(byCreditSource),
    topConsumers,
    dailyUsage,
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
  creditCost: number
  durationMs: number
  success: boolean
  createdAt: string
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
  totalCredits: number
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
    actionType: { in: ['ai_proxy_completion', 'chat_message'] },
    createdAt: { gte: since },
  }
  if (scope.workspaceId) where.workspaceId = scope.workspaceId
  if (scope.projectId) where.projectId = scope.projectId
  if (options.userId) where.memberId = options.userId
  // Model filter: search inside JSON actionMetadata
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

  const entries: UsageLogEntry[] = events.map((event) => {
    const meta = (event.actionMetadata as Record<string, any>) || {}
    const user = userMap.get(event.memberId)
    return {
      id: event.id,
      userId: event.memberId,
      userName: user?.name ?? null,
      userEmail: user?.email ?? event.memberId,
      userImage: user?.image ?? null,
      model: meta.model || meta.modelUsed || 'unknown',
      provider: meta.provider || 'anthropic',
      inputTokens: meta.inputTokens || 0,
      outputTokens: meta.outputTokens || 0,
      totalTokens: meta.totalTokens || 0,
      creditCost: event.creditCost,
      durationMs: meta.durationMs || 0,
      success: meta.success !== false,
      createdAt: event.createdAt.toISOString(),
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
  period: AnalyticsPeriod = '30d'
) {
  const since = periodToDate(period)

  const where: any = {
    actionType: { in: ['ai_proxy_completion', 'chat_message'] },
    createdAt: { gte: since },
  }
  if (scope.workspaceId) where.workspaceId = scope.workspaceId
  if (scope.projectId) where.projectId = scope.projectId

  // Fetch all matching events (for in-memory aggregation)
  const events = await prisma.usageEvent.findMany({
    where,
    select: {
      memberId: true,
      creditCost: true,
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
    totalCredits: number
    totalDurationMs: number
  }>()

  for (const event of events) {
    const meta = (event.actionMetadata as Record<string, any>) || {}
    const model = meta.model || meta.modelUsed || 'unknown'
    const key = `${event.memberId}::${model}`
    const existing = aggregateMap.get(key)

    if (existing) {
      existing.requestCount += 1
      existing.totalInputTokens += meta.inputTokens || 0
      existing.totalOutputTokens += meta.outputTokens || 0
      existing.totalTokens += meta.totalTokens || 0
      existing.totalCredits += event.creditCost
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
        totalCredits: event.creditCost,
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
        model: agg.model,
        provider: agg.provider,
        requestCount: agg.requestCount,
        totalInputTokens: agg.totalInputTokens,
        totalOutputTokens: agg.totalOutputTokens,
        totalTokens: agg.totalTokens,
        totalCredits: agg.totalCredits,
        avgDurationMs: agg.requestCount > 0 ? Math.round(agg.totalDurationMs / agg.requestCount) : 0,
      }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)

  // Compute totals
  const totals = {
    totalRequests: events.length,
    totalInputTokens: summaries.reduce((s, e) => s + e.totalInputTokens, 0),
    totalOutputTokens: summaries.reduce((s, e) => s + e.totalOutputTokens, 0),
    totalTokens: summaries.reduce((s, e) => s + e.totalTokens, 0),
    totalCredits: summaries.reduce((s, e) => s + e.totalCredits, 0),
    totalToolCalls,
    uniqueUsers: new Set(summaries.map((s) => s.userId)).size,
    uniqueModels: new Set(summaries.map((s) => s.model)).size,
  }

  return { summaries, totals }
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
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.chatMessage.count({
      where: { session: sessionWhere },
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
