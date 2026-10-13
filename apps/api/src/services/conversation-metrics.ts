// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel usage metrics behind the stage gates: weekly active channel users
 * as a share of workspace members, messages per active user, agent mentions
 * and agent-authored posts, and native versus bridged message share.
 *
 * Derived from the message tables rather than a separate event stream, so the
 * numbers can be recomputed for any past week.
 */

import { prisma } from '../lib/prisma'

const db = prisma as any

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_METRIC_WEEKS = 26
/** Share of workspace members weekly active in channels that clears the Stage 3 gate. */
export const DESIGN_PARTNER_ACTIVE_SHARE = 0.5
/** `externalRef` prefix for messages mirrored in from Slack by the bridge. */
export const SLACK_BRIDGE_REF_PREFIX = 'slack:'

export interface ChannelWeekMetrics {
  weekStart: string
  weekEnd: string
  activeUsers: number
  activeShare: number
  humanMessages: number
  messagesPerActiveUser: number
  agentMentions: number
  agentPosts: number
  nativeMessages: number
  bridgedMessages: number
  bridgedShare: number
}

export interface ChannelMetrics {
  workspaceId: string
  memberCount: number
  weeks: ChannelWeekMetrics[]
  gate: { latestActiveShare: number; meetsActiveShareGate: boolean }
}

async function workspaceMemberIds(workspaceId: string): Promise<Set<string>> {
  const rows = await db.member.findMany({ where: { workspaceId, projectId: null }, select: { userId: true } })
  return new Set(rows.map((r: any) => r.userId).filter(Boolean))
}

function ratio(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 1000 : 0
}

async function weekMetrics(
  workspaceId: string,
  memberIds: Set<string>,
  start: Date,
  end: Date,
): Promise<ChannelWeekMetrics> {
  const inWeek = { workspaceId, createdAt: { gte: start, lt: end }, deletedAt: null }
  const bridged = { externalRef: { startsWith: SLACK_BRIDGE_REF_PREFIX } }

  const [posters, readers, agentPosts, bridgedMessages, agentMentions] = await Promise.all([
    db.conversationMessage.groupBy({
      by: ['authorUserId'],
      where: {
        ...inWeek,
        authorType: 'user',
        authorUserId: { not: null },
        OR: [{ externalRef: null }, { NOT: bridged }],
      },
      _count: { _all: true },
    }),
    db.conversationMember.findMany({
      where: {
        memberType: 'user',
        userId: { not: null },
        lastReadAt: { gte: start, lt: end },
        conversation: { workspaceId },
      },
      select: { userId: true },
    }),
    db.conversationMessage.count({ where: { ...inWeek, authorType: 'agent' } }),
    db.conversationMessage.count({ where: { ...inWeek, authorType: { in: ['user', 'agent'] }, ...bridged } }),
    db.conversationMention.count({
      where: { targetType: 'agent', message: inWeek },
    }),
  ])

  const active = new Set<string>()
  let humanMessages = 0
  for (const row of posters) {
    if (!memberIds.has(row.authorUserId)) continue
    active.add(row.authorUserId)
    humanMessages += row._count._all
  }
  for (const row of readers) if (memberIds.has(row.userId)) active.add(row.userId)

  const nativeMessages = humanMessages + agentPosts
  return {
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    activeUsers: active.size,
    activeShare: ratio(active.size, memberIds.size),
    humanMessages,
    messagesPerActiveUser: ratio(humanMessages, active.size),
    agentMentions,
    agentPosts,
    nativeMessages,
    bridgedMessages,
    bridgedShare: ratio(bridgedMessages, nativeMessages + bridgedMessages),
  }
}

/**
 * Rolling 7-day windows ending at `now`, newest first. Readers only count for
 * the window their latest read falls in, so older weeks lean on posting.
 */
export async function getChannelMetrics(
  workspaceId: string,
  opts: { weeks?: number; now?: Date } = {},
): Promise<ChannelMetrics> {
  const weeks = Math.min(Math.max(Math.floor(opts.weeks ?? 8), 1), MAX_METRIC_WEEKS)
  const now = opts.now ?? new Date()
  const memberIds = await workspaceMemberIds(workspaceId)
  const rows: ChannelWeekMetrics[] = []
  for (let i = 0; i < weeks; i++) {
    const end = new Date(now.getTime() - i * WEEK_MS)
    rows.push(await weekMetrics(workspaceId, memberIds, new Date(end.getTime() - WEEK_MS), end))
  }
  const latestActiveShare = rows[0]?.activeShare ?? 0
  return {
    workspaceId,
    memberCount: memberIds.size,
    weeks: rows,
    gate: { latestActiveShare, meetsActiveShareGate: latestActiveShare >= DESIGN_PARTNER_ACTIVE_SHARE },
  }
}

/** Workspaces with channel traffic in the last 7 days, busiest first, for the admin view. */
export async function listChannelMetricsOverview(
  opts: { limit?: number; now?: Date } = {},
): Promise<Array<{ workspaceId: string; workspaceName: string | null; memberCount: number } & ChannelWeekMetrics>> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200)
  const now = opts.now ?? new Date()
  const start = new Date(now.getTime() - WEEK_MS)
  const busiest = await db.conversationMessage.groupBy({
    by: ['workspaceId'],
    where: { createdAt: { gte: start, lt: now }, deletedAt: null, authorType: { in: ['user', 'agent'] } },
    _count: { _all: true },
    orderBy: { _count: { workspaceId: 'desc' } },
    take: limit,
  })
  const ids = busiest.map((r: any) => r.workspaceId)
  const workspaces = await db.workspace.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  const names = new Map(workspaces.map((w: any) => [w.id, w.name]))
  return Promise.all(
    ids.map(async (workspaceId: string) => {
      const memberIds = await workspaceMemberIds(workspaceId)
      const week = await weekMetrics(workspaceId, memberIds, start, now)
      return { workspaceId, workspaceName: (names.get(workspaceId) as string) ?? null, memberCount: memberIds.size, ...week }
    }),
  )
}
