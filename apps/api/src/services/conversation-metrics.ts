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
/**
 * `externalRef` prefixes the chat bridge stamps on mirrored messages
 * (`externalRefFor` in `chat-providers/types.ts`). Anything else in
 * `externalRef` — e.g. `activity:` notifications — is not bridged traffic.
 */
export const BRIDGE_REF_PREFIXES = ['slack:', 'teams:', 'google_chat:'] as const

/** Matches messages mirrored in from an external chat provider. */
export const bridgedMessageWhere = () => ({
  OR: BRIDGE_REF_PREFIXES.map((prefix) => ({ externalRef: { startsWith: prefix } })),
})

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
  const bridged = bridgedMessageWhere()

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

// ============================================================================
// Per-channel breakdown
// ============================================================================

export interface ChannelBreakdownRow {
  conversationId: string
  name: string | null
  slug: string | null
  kind: string
  /** `shogo` for a native channel, else the provider the channel mirrors. */
  provider: string
  /** True for channels bridged from Slack / Teams / Google Chat. */
  bridged: boolean
  /** Every message in the window: human + agent + mirrored in from a provider. */
  messages: number
  /** Human posts written in Shogo (bridged posts are counted under `bridgedMessages`). */
  humanMessages: number
  /** Agent posts written in Shogo. */
  agentMessages: number
  /** Messages mirrored in from the external provider. */
  bridgedMessages: number
  /** Agent @mentions on messages in this channel. */
  agentMentions: number
  /** Distinct workspace members who posted or read the channel in the window. */
  activeMembers: number
  /** Last activity ever in the channel, not limited to the window. */
  lastMessageAt: string | null
}

export interface ChannelBreakdown {
  workspaceId: string
  window: { from: string; to: string }
  totals: {
    channels: number
    activeUsers: number
    messages: number
    humanMessages: number
    agentMessages: number
    bridgedMessages: number
    agentMentions: number
    /** Bridged share of all channel messages, matching `getChannelMetrics`. */
    bridgedShare: number
    messagesPerActiveUser: number
  }
  channels: ChannelBreakdownRow[]
}

/**
 * One row per channel (public/private conversations; DMs are excluded) for an
 * explicit window, plus workspace totals over those channels. Totals use the
 * same definitions as `getChannelMetrics`, so a workspace without DM traffic
 * reports the same active-user and bridged-share figures through both.
 */
export async function getChannelBreakdown(
  workspaceId: string,
  window: { from: Date; to: Date },
): Promise<ChannelBreakdown> {
  const { from, to } = window
  const empty: ChannelBreakdown = {
    workspaceId,
    window: { from: from.toISOString(), to: to.toISOString() },
    totals: {
      channels: 0,
      activeUsers: 0,
      messages: 0,
      humanMessages: 0,
      agentMessages: 0,
      bridgedMessages: 0,
      agentMentions: 0,
      bridgedShare: 0,
      messagesPerActiveUser: 0,
    },
    channels: [],
  }

  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      kind: { in: ['public', 'private'] },
      dmKey: null,
      archivedAt: null,
    },
    select: { id: true, name: true, slug: true, kind: true, provider: true, lastMessageAt: true },
  })
  if (conversations.length === 0) return empty

  const ids: string[] = conversations.map((c: any) => c.id)
  const memberIds = await workspaceMemberIds(workspaceId)
  const inWindow = { workspaceId, conversationId: { in: ids }, createdAt: { gte: from, lt: to }, deletedAt: null }
  const bridged = bridgedMessageWhere()

  const [byAuthor, bridgedByChannel, mentionByMessage, posters, readers] = await Promise.all([
    db.conversationMessage.groupBy({
      by: ['conversationId', 'authorType'],
      where: { ...inWindow, authorType: { in: ['user', 'agent', 'system'] } },
      _count: { _all: true },
    }),
    db.conversationMessage.groupBy({
      by: ['conversationId'],
      where: { ...inWindow, ...bridged },
      _count: { _all: true },
    }),
    db.conversationMention.groupBy({
      by: ['messageId'],
      where: { targetType: 'agent', message: inWindow },
      _count: { _all: true },
    }),
    // Human posts written in Shogo, one row per (channel, author).
    db.conversationMessage.groupBy({
      by: ['conversationId', 'authorUserId'],
      where: {
        ...inWindow,
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
        lastReadAt: { gte: from, lt: to },
        conversationId: { in: ids },
      },
      select: { conversationId: true, userId: true },
    }),
  ])

  const mentionCounts = await mentionsByConversation(mentionByMessage, workspaceId)

  const humanByChannel = new Map<string, number>()
  const activeByChannel = new Map<string, Set<string>>()
  for (const row of posters) {
    if (!memberIds.has(row.authorUserId)) continue
    humanByChannel.set(row.conversationId, (humanByChannel.get(row.conversationId) ?? 0) + row._count._all)
    const active = activeByChannel.get(row.conversationId) ?? new Set<string>()
    active.add(row.authorUserId)
    activeByChannel.set(row.conversationId, active)
  }
  for (const row of readers) {
    if (!memberIds.has(row.userId)) continue
    const active = activeByChannel.get(row.conversationId) ?? new Set<string>()
    active.add(row.userId)
    activeByChannel.set(row.conversationId, active)
  }

  const bridgedByChannelMap = new Map<string, number>()
  for (const row of bridgedByChannel) bridgedByChannelMap.set(row.conversationId, row._count._all)

  const agentByChannel = new Map<string, number>()
  const systemByChannel = new Map<string, number>()
  for (const row of byAuthor) {
    const target = row.authorType === 'agent' ? agentByChannel : row.authorType === 'system' ? systemByChannel : null
    if (target) target.set(row.conversationId, (target.get(row.conversationId) ?? 0) + row._count._all)
  }

  const channels: ChannelBreakdownRow[] = conversations.map((c: any) => {
    const humanMessages = humanByChannel.get(c.id) ?? 0
    const agentMessages = agentByChannel.get(c.id) ?? 0
    const bridgedMessages = bridgedByChannelMap.get(c.id) ?? 0
    const systemMessages = systemByChannel.get(c.id) ?? 0
    return {
      conversationId: c.id,
      name: c.name ?? null,
      slug: c.slug ?? null,
      kind: c.kind,
      provider: c.provider ?? 'shogo',
      bridged: (c.provider ?? 'shogo') !== 'shogo',
      messages: humanMessages + agentMessages + bridgedMessages + systemMessages,
      humanMessages,
      agentMessages,
      bridgedMessages,
      agentMentions: mentionCounts.get(c.id) ?? 0,
      activeMembers: activeByChannel.get(c.id)?.size ?? 0,
      lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
    }
  })
  channels.sort(
    (a, b) =>
      b.messages - a.messages ||
      (b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0) - (a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')),
  )

  const activeUsers = new Set<string>()
  for (const active of activeByChannel.values()) for (const userId of active) activeUsers.add(userId)

  const sum = (pick: (row: ChannelBreakdownRow) => number) => channels.reduce((n, row) => n + pick(row), 0)
  const humanMessages = sum((r) => r.humanMessages)
  const agentMessages = sum((r) => r.agentMessages)
  const bridgedMessages = sum((r) => r.bridgedMessages)
  const nativeMessages = humanMessages + agentMessages

  return {
    workspaceId,
    window: { from: from.toISOString(), to: to.toISOString() },
    totals: {
      channels: channels.length,
      activeUsers: activeUsers.size,
      messages: sum((r) => r.messages),
      humanMessages,
      agentMessages,
      bridgedMessages,
      agentMentions: sum((r) => r.agentMentions),
      bridgedShare: ratio(bridgedMessages, nativeMessages + bridgedMessages),
      messagesPerActiveUser: ratio(humanMessages, activeUsers.size),
    },
    channels,
  }
}

/** `ConversationMention` rows carry a message id only, so fold them back onto their channel. */
async function mentionsByConversation(
  mentionByMessage: Array<{ messageId: string; _count: { _all: number } }>,
  workspaceId: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (mentionByMessage.length === 0) return counts

  const owners = await db.conversationMessage.findMany({
    where: { id: { in: mentionByMessage.map((r) => r.messageId) }, workspaceId },
    select: { id: true, conversationId: true },
  })
  const channelOf = new Map<string, string>(owners.map((m: any) => [m.id, m.conversationId]))
  for (const row of mentionByMessage) {
    const conversationId = channelOf.get(row.messageId)
    if (conversationId) counts.set(conversationId, (counts.get(conversationId) ?? 0) + row._count._all)
  }
  return counts
}
