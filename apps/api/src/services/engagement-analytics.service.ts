// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Engagement + work-activity analytics.
 *
 * Answers two questions from data we already record per person:
 *   - "How much is this person using Shogo?" (tokens, sessions, streaks,
 *     heatmap, peak hour, model share)
 *   - "What did they actually get done?" (messages sent, approvals decided,
 *     tasks finished, lines changed, projects touched)
 *
 * No new tables. Each signal comes from a row that is already keyed by user:
 *   UsageEvent.memberId            tokens, model, spend, project, chat session
 *   ToolCallLog.userId             tool calls and lines added/removed
 *   ConversationMessage.authorUserId + blocks.approval.decidedBy
 *                                  team chat messages and approvals decided
 *   GoalEvent.metadata.decidedByUserId   goal "Needs your OK" decisions
 *   AgentTask.userId               tasks started and completed
 *   Meeting.userId                 meetings recorded
 *
 * Callers are responsible for authorization (who may see whose numbers); this
 * module only aggregates. See routes/scoped-analytics.ts.
 */

import { prisma } from '../lib/prisma'
import { resolveModelLabels } from './model-registry.service'
import {
  activeDaySet,
  computeEngagement,
  computeStreaks,
  computeWorkTotals,
  emptyRaw,
  groupRawByUser,
  makeZoneClock,
  resolveActivityWindow,
  type ApprovalRow,
  type EngagementStats,
  type RawActivity,
  type WorkTotals,
} from '../lib/engagement-compute'
import { periodToWindow, type AnalyticsPeriod } from './analytics.service'

export type EngagementPeriod = AnalyticsPeriod | 'all'

export interface EngagementScope {
  /** Limit to one workspace. Without it, `userId` spans all of that user's workspaces. */
  workspaceId?: string
  /** Limit to one person. Without it, the whole workspace is aggregated. */
  userId?: string
}

/** "All time" is capped so one request cannot scan years of team activity. */
export const ALL_TIME_DAYS = 730

const isSqlite = () => process.env.SHOGO_LOCAL_MODE === 'true'

const USAGE_ACTIONS = [
  'ai_proxy_completion',
  'chat_message',
  'voice_minutes_inbound',
  'voice_minutes_outbound',
  'voice_number_setup',
  'voice_number_monthly',
  'ai_live_session_minutes',
]

/** Channel approval cards are matched this far back from the window start, since they are decided after they are posted. */
const APPROVAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

export function engagementWindow(
  period: EngagementPeriod = '30d',
  fromIso?: string,
  toIso?: string,
): { from: Date; to: Date } {
  if (period === 'all' && !(fromIso && toIso)) {
    const to = new Date()
    return { from: new Date(to.getTime() - ALL_TIME_DAYS * 24 * 60 * 60 * 1000), to }
  }
  return periodToWindow(period === 'all' ? undefined : period, fromIso, toIso)
}

// ============================================================================
// Collection
// ============================================================================

function parseJson(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object') return value as Record<string, any>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function usageCostUsd(event: { billedUsd: number; rawUsd: number | null }, meta: Record<string, any>): number {
  if (event.billedUsd > 0) return event.billedUsd
  if (event.rawUsd != null && event.rawUsd > 0) return event.rawUsd
  const fromMeta = (meta.rawUsd as number | undefined) ?? (meta.dollarCost as number | undefined)
  return typeof fromMeta === 'number' ? fromMeta : 0
}

async function resolveWorkspaceIds(scope: EngagementScope): Promise<string[]> {
  if (scope.workspaceId) return [scope.workspaceId]
  if (!scope.userId) return []
  const memberships = await prisma.member.findMany({
    where: { userId: scope.userId, workspaceId: { not: null } },
    select: { workspaceId: true },
  })
  return [...new Set(memberships.map((m) => m.workspaceId).filter((id): id is string => !!id))]
}

/** Fetch every attributable action in the window. Scope must name a workspace or a user. */
export async function collectActivity(
  scope: EngagementScope,
  window: { from: Date; to: Date },
): Promise<RawActivity> {
  const workspaceIds = await resolveWorkspaceIds(scope)
  if (workspaceIds.length === 0) return emptyRaw()

  const { from, to } = window
  const createdAt = { gte: from, lte: to }
  const user = scope.userId

  const [usageEvents, toolCalls, messages, approvalMessages, goalEvents, tasks, meetings] = await Promise.all([
    prisma.usageEvent.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        actionType: { in: USAGE_ACTIONS },
        createdAt,
        ...(user ? { memberId: user } : { memberId: { not: 'system' } }),
      },
      select: {
        memberId: true,
        projectId: true,
        billedUsd: true,
        rawUsd: true,
        actionMetadata: true,
        createdAt: true,
      },
    }),
    prisma.toolCallLog.findMany({
      where: {
        createdAt,
        userId: user ?? { not: null },
        chatSession: {
          OR: [
            { workspaceId: { in: workspaceIds } },
            { project: { workspaceId: { in: workspaceIds } } },
          ],
        },
      },
      select: {
        userId: true,
        toolName: true,
        status: true,
        linesAdded: true,
        linesRemoved: true,
        chatSessionId: true,
        createdAt: true,
      },
    }),
    prisma.conversationMessage.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        authorType: 'user',
        authorUserId: user ?? { not: null },
        deletedAt: null,
        createdAt,
      },
      select: { authorUserId: true, createdAt: true },
    }),
    // Approval cards are agent-authored; the decider lives inside `blocks`.
    prisma.conversationMessage.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        authorType: 'agent',
        createdAt: { gte: new Date(from.getTime() - APPROVAL_LOOKBACK_MS), lte: to },
        blocks: (isSqlite()
          ? { contains: 'approval_request' }
          : { path: ['type'], equals: 'approval_request' }) as any,
      },
      select: { blocks: true },
    }),
    prisma.goalEvent.findMany({
      where: {
        kind: 'approval',
        goal: { workspaceId: { in: workspaceIds } },
        createdAt: { gte: new Date(from.getTime() - APPROVAL_LOOKBACK_MS), lte: to },
      },
      select: { message: true, metadata: true },
    }),
    prisma.agentTask.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        ...(user ? { userId: user } : {}),
        OR: [
          { createdAt },
          { startedAt: createdAt },
          { completedAt: createdAt },
        ],
      },
      select: {
        userId: true,
        projectId: true,
        title: true,
        status: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        resultSummary: true,
      },
    }),
    prisma.meeting.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        userId: user ?? { not: null },
        createdAt,
      },
      select: { userId: true, createdAt: true },
    }),
  ])

  const approvals: ApprovalRow[] = []
  for (const row of approvalMessages) {
    const blocks = parseJson(row.blocks)
    const approval = blocks?.type === 'approval_request' ? blocks.approval : null
    const decidedBy = approval?.decidedBy?.userId
    const decidedAt = approval?.decidedAt ? new Date(approval.decidedAt) : null
    if (!decidedBy || !decidedAt || isNaN(decidedAt.getTime())) continue
    if (approval.status !== 'approved' && approval.status !== 'denied') continue
    if (decidedAt < from || decidedAt > to) continue
    if (user && decidedBy !== user) continue
    approvals.push({
      userId: decidedBy,
      decision: approval.status,
      at: decidedAt,
      source: 'channel',
      label: typeof approval.summary === 'string' ? approval.summary : 'Agent approval',
    })
  }
  for (const event of goalEvents) {
    const meta = parseJson(event.metadata)
    const decidedBy = typeof meta?.decidedByUserId === 'string' ? meta.decidedByUserId : null
    const resolvedAt = typeof meta?.resolvedAt === 'string' ? new Date(meta.resolvedAt) : null
    if (!decidedBy || !resolvedAt || isNaN(resolvedAt.getTime())) continue
    if (meta?.decision !== 'approved' && meta?.decision !== 'declined') continue
    if (resolvedAt < from || resolvedAt > to) continue
    if (user && decidedBy !== user) continue
    approvals.push({
      userId: decidedBy,
      decision: meta.decision === 'approved' ? 'approved' : 'denied',
      at: resolvedAt,
      source: 'goal',
      label: event.message,
    })
  }

  return {
    usage: usageEvents.map((e) => {
      const meta = parseJson(e.actionMetadata) ?? {}
      return {
        userId: e.memberId,
        projectId: e.projectId,
        chatSessionId: typeof meta.chatSessionId === 'string' ? meta.chatSessionId : null,
        createdAt: e.createdAt,
        tokens: Number(meta.totalTokens) || 0,
        model: String(meta.model || meta.modelUsed || 'unknown'),
        costUsd: usageCostUsd(e, meta),
      }
    }),
    tools: toolCalls.map((t) => ({
      userId: t.userId as string,
      toolName: t.toolName,
      status: t.status,
      linesAdded: t.linesAdded,
      linesRemoved: t.linesRemoved,
      chatSessionId: t.chatSessionId,
      createdAt: t.createdAt,
    })),
    messages: messages.map((m) => ({ userId: m.authorUserId as string, createdAt: m.createdAt })),
    approvals,
    tasks: tasks.map((t) => ({
      userId: t.userId,
      projectId: t.projectId,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      resultSummary: t.resultSummary,
    })),
    meetings: meetings.map((m) => ({ userId: m.userId as string, createdAt: m.createdAt })),
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Z Code-style dashboard payload plus work totals for one person or a whole workspace. */
export async function getEngagementStats(
  scope: EngagementScope,
  period: EngagementPeriod = '30d',
  tz?: string | null,
  options: { fromIso?: string; toIso?: string } = {},
): Promise<EngagementStats> {
  const window = engagementWindow(period, options.fromIso, options.toIso)
  return getEngagementStatsForWindow(scope, window, tz)
}

export async function getEngagementStatsForWindow(
  scope: EngagementScope,
  window: { from: Date; to: Date },
  tz?: string | null,
): Promise<EngagementStats> {
  const raw = await collectActivity(scope, window)
  const labels = await resolveModelLabels(raw.usage.map((u) => u.model))
  return computeEngagement(raw, window, tz, {
    modelLabel: (model) => labels.get(model) ?? model,
  })
}

export interface TeamWorkRow {
  userId: string
  name: string | null
  email: string | null
  image: string | null
  role: string | null
  totals: WorkTotals
  streak: { current: number; longest: number }
}

export interface TeamWork {
  tz: string
  from: string
  to: string
  team: WorkTotals
  rows: TeamWorkRow[]
}

/** One row per current workspace member (including people with no activity), plus a team total. */
export async function getTeamWork(
  workspaceId: string,
  period: EngagementPeriod = '30d',
  tz?: string | null,
  options: { fromIso?: string; toIso?: string } = {},
): Promise<TeamWork> {
  const window = engagementWindow(period, options.fromIso, options.toIso)
  const clock = makeZoneClock(tz)
  const todayKey = clock.dayKey(window.to)

  const [raw, members] = await Promise.all([
    collectActivity({ workspaceId }, window),
    prisma.member.findMany({
      where: { workspaceId, projectId: null },
      select: {
        userId: true,
        role: true,
        user: { select: { name: true, email: true, image: true } },
      },
    }),
  ])

  const byUser = groupRawByUser(raw)
  const known = new Map(members.map((m) => [m.userId, m]))

  // Former members with recorded activity still show up, so totals add up.
  const missing = [...byUser.keys()].filter((id) => !known.has(id))
  const extraUsers = missing.length
    ? await prisma.user.findMany({
        where: { id: { in: missing } },
        select: { id: true, name: true, email: true, image: true },
      })
    : []
  const extraById = new Map(extraUsers.map((u) => [u.id, u]))

  const rows: TeamWorkRow[] = [...new Set([...known.keys(), ...byUser.keys()])].map((userId) => {
    const userRaw = byUser.get(userId) ?? emptyRaw()
    const member = known.get(userId)
    const extra = extraById.get(userId)
    return {
      userId,
      name: member?.user?.name ?? extra?.name ?? null,
      email: member?.user?.email ?? extra?.email ?? null,
      image: member?.user?.image ?? extra?.image ?? null,
      role: member?.role ?? null,
      totals: computeWorkTotals(userRaw, clock, window),
      streak: computeStreaks(activeDaySet(userRaw, clock, window), todayKey),
    }
  })

  rows.sort(
    (a, b) =>
      b.totals.approvalsDecided + b.totals.tasksCompleted + b.totals.messagesSent -
        (a.totals.approvalsDecided + a.totals.tasksCompleted + a.totals.messagesSent) ||
      b.totals.tokens - a.totals.tokens,
  )

  return {
    tz: clock.tz,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    team: computeWorkTotals(raw, clock, window),
    rows,
  }
}

// ============================================================================
// "What did PERSON work on?" (for the workspace agent)
// ============================================================================

export interface WorkspaceMemberRef {
  userId: string
  name: string | null
  email: string | null
  role: string
}

/** Find a current workspace member by user id or email. Null when they are not in this workspace. */
export async function findWorkspaceMember(
  workspaceId: string,
  idOrEmail: string,
): Promise<WorkspaceMemberRef | null> {
  const needle = idOrEmail.trim()
  if (!needle) return null
  const select = { userId: true, role: true, user: { select: { name: true, email: true } } }

  const byId = await prisma.member.findFirst({ where: { workspaceId, projectId: null, userId: needle }, select })
  const member =
    byId ??
    (await prisma.member.findFirst({
      where: { workspaceId, projectId: null, user: { email: { in: [needle, needle.toLowerCase()] } } },
      select,
    }))
  if (!member) return null
  return {
    userId: member.userId,
    name: member.user?.name ?? null,
    email: member.user?.email ?? null,
    role: member.role,
  }
}

export interface MemberWorkActivity {
  user: WorkspaceMemberRef
  window: { from: string; to: string; tz: string; label: string }
  totals: WorkTotals
  streak: { current: number; longest: number }
  peakHour: number | null
  recent: EngagementStats['recent']
  topTools: EngagementStats['topTools']
  models: EngagementStats['modelShare']
}

/**
 * A compact, prose-friendly summary of one person's activity for an agent to
 * describe. Deliberately omits the heatmap and per-day series: they are for
 * charts and would only cost the model tokens.
 */
export async function getMemberWorkActivity(
  workspaceId: string,
  member: WorkspaceMemberRef,
  input: { range?: string | null; since?: string | null; until?: string | null; tz?: string | null },
  now: Date = new Date(),
): Promise<MemberWorkActivity> {
  const tz = makeZoneClock(input.tz).tz
  const { from, to, label } = resolveActivityWindow({ ...input, tz }, now)
  const stats = await getEngagementStatsForWindow({ workspaceId, userId: member.userId }, { from, to }, tz)
  return {
    user: member,
    window: { from: from.toISOString(), to: to.toISOString(), tz, label },
    totals: stats.totals,
    streak: stats.streak,
    peakHour: stats.peakHour,
    recent: stats.recent,
    topTools: stats.topTools.slice(0, 5),
    models: stats.modelShare.slice(0, 3),
  }
}
