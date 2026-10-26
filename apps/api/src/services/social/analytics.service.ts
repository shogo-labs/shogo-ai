// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What happened on the workspace's accounts, for a date range.
 *
 * Deliberately computed from **our own rows** and never from the provider: every
 * post leg, comment, thread and message arrives here through the webhook ingress
 * or the sweep (P3/P4), so this answers "what did we publish and who answered"
 * without a second source of truth that can disagree with the inbox the user is
 * looking at — and without inventing a provider analytics endpoint. The one
 * provider-billed number it does include, `usage`, is read from the wallet's own
 * `UsageEvent` rows, not from a rate table.
 *
 * Reach/impressions are not here on purpose: they are the provider's numbers and
 * nothing in this card stores them yet. A future phase can sync them into their
 * own table without changing this shape.
 */

import { prisma } from '../../lib/prisma'
import { socialUsageSummary, type SocialUsageSummary } from './usage.service'

const db = prisma as any

const RANGE_SAFETY_MS = 366 * 86_400_000

export interface SocialAnalytics {
  from: string
  to: string
  posts: {
    published: number
    scheduled: number
    draft: number
    failed: number
    partial: number
    /** Published post legs per platform; a post to 3 accounts counts 3 legs. */
    byPlatform: Array<{ platform: string; published: number; failed: number }>
  }
  engagement: {
    comments: number
    awaitingReply: number
    replied: number
    /** Automation executions recorded in the range (one row per provider run). */
    automationRuns: number
    automations: { active: number; paused: number; failedRuns: number }
  }
  inbox: {
    conversations: number
    unreadThreads: number
    unreadMessages: number
    incoming: number
    outgoing: number
  }
  accounts: {
    total: number
    active: number
    needsReconnect: number
    byPlatform: Array<{ platform: string; accounts: number }>
  }
  usage: SocialUsageSummary
}

function groupTally(
  groups: Array<{ _count?: { _all?: number } } & Record<string, any>>,
  key: string,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const group of groups) {
    const name = typeof group[key] === 'string' ? (group[key] as string) : ''
    if (!name) continue
    out.set(name, (out.get(name) ?? 0) + (group._count?._all ?? 0))
  }
  return out
}

/**
 * Analytics for `[from, to]`.
 *
 * The range is capped at a year so a mistyped query cannot walk the whole
 * history of a busy workspace; `usage` is always the current calendar month,
 * because that is the period the wallet actually bills.
 */
export async function socialAnalytics(
  workspaceId: string,
  opts: { from: Date; to: Date },
): Promise<SocialAnalytics> {
  const from = opts.from
  const to = opts.to
  if (to.getTime() <= from.getTime()) {
    throw new Error('to must be after from')
  }
  if (to.getTime() - from.getTime() > RANGE_SAFETY_MS) {
    throw new Error('range must be a year or less')
  }

  const inRange = { gte: from, lte: to }

  const [postGroups, targetGroups, commentGroups, conversations, unreadAgg, incoming, outgoing, accountGroups] =
    await Promise.all([
      db.socialPost.groupBy({
        by: ['status'],
        where: { workspaceId, createdAt: inRange },
        _count: { _all: true },
      }),
      db.socialPostTarget.groupBy({
        by: ['platform', 'status'],
        where: { post: { workspaceId, createdAt: inRange } },
        _count: { _all: true },
      }),
      db.socialComment.groupBy({
        by: ['status'],
        where: { workspaceId, occurredAt: inRange },
        _count: { _all: true },
      }),
      db.socialConversation.count({ where: { workspaceId } }),
      db.socialConversation.aggregate({ where: { workspaceId }, _sum: { unreadCount: true } }),
      db.socialMessage.count({ where: { workspaceId, direction: 'incoming', sentAt: inRange } }),
      db.socialMessage.count({ where: { workspaceId, direction: 'outgoing', sentAt: inRange } }),
      db.socialAccount.groupBy({
        by: ['platform', 'isActive'],
        where: { workspaceId },
        _count: { _all: true },
      }),
    ])

  const unreadThreads = await db.socialConversation.count({
    where: { workspaceId, unreadCount: { gt: 0 } },
  })

  const postStatus = groupTally(postGroups, 'status')
  const commentStatus = groupTally(commentGroups, 'status')

  const byPlatform = new Map<string, { platform: string; published: number; failed: number }>()
  for (const group of targetGroups as Array<Record<string, any>>) {
    const platform = typeof group.platform === 'string' ? group.platform : ''
    if (!platform) continue
    const entry = byPlatform.get(platform) ?? { platform, published: 0, failed: 0 }
    const count = group._count?._all ?? 0
    if (group.status === 'published') entry.published += count
    if (group.status === 'failed') entry.failed += count
    byPlatform.set(platform, entry)
  }

  const accountsByPlatform = new Map<string, number>()
  let accountsTotal = 0
  let accountsActive = 0
  for (const group of accountGroups as Array<Record<string, any>>) {
    const platform = typeof group.platform === 'string' ? group.platform : ''
    const count = group._count?._all ?? 0
    accountsTotal += count
    if (group.isActive) {
      accountsActive += count
      if (platform) accountsByPlatform.set(platform, (accountsByPlatform.get(platform) ?? 0) + count)
    }
  }
  const needsReconnect = await db.socialAccount.count({
    where: { workspaceId, isActive: true, needsReconnect: true },
  })

  // Automation runs are counted from one row per provider execution, so the
  // window is a real range question rather than a lifetime counter.
  const [automationRuns, failedRuns, automationsActive, automationsPaused] = await Promise.all([
    db.socialAutomationRun.count({ where: { workspaceId, startedAt: inRange } }),
    db.socialAutomationRun.count({ where: { workspaceId, startedAt: inRange, status: 'failed' } }),
    db.socialAutomation.count({ where: { workspaceId, status: 'active' } }),
    db.socialAutomation.count({ where: { workspaceId, status: 'paused' } }),
  ])

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    posts: {
      published: postStatus.get('published') ?? 0,
      scheduled: postStatus.get('scheduled') ?? 0,
      draft: postStatus.get('draft') ?? 0,
      failed: postStatus.get('failed') ?? 0,
      partial: postStatus.get('partial') ?? 0,
      byPlatform: [...byPlatform.values()].sort((a, b) => b.published - a.published),
    },
    engagement: {
      comments: (commentStatus.get('new') ?? 0) + (commentStatus.get('read') ?? 0) + (commentStatus.get('replied') ?? 0),
      awaitingReply: (commentStatus.get('new') ?? 0) + (commentStatus.get('read') ?? 0),
      replied: commentStatus.get('replied') ?? 0,
      automationRuns,
      automations: { active: automationsActive, paused: automationsPaused, failedRuns },
    },
    inbox: {
      conversations,
      unreadThreads,
      unreadMessages: unreadAgg?._sum?.unreadCount ?? 0,
      incoming,
      outgoing,
    },
    accounts: {
      total: accountsTotal,
      active: accountsActive,
      needsReconnect,
      byPlatform: [...accountsByPlatform.entries()]
        .map(([platform, accounts]) => ({ platform, accounts }))
        .sort((a, b) => b.accounts - a.accounts),
    },
    usage: await socialUsageSummary(workspaceId),
  }
}
