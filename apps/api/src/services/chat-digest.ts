// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily email digest of unread inbox items and direct messages, sent around
 * 9am in each person's timezone to people who opted in.
 */

import { prisma } from '../lib/prisma'
import { getFrontendUrl } from '../lib/cloud-urls'
import { sendChannelDigestEmail } from './email.service'
import { getWorkspaceChatConfig, nativeChatEnabled } from './chat-mode'

const db = prisma as any

export const DIGEST_LOCAL_HOUR = 9
const MIN_GAP_MS = 20 * 60 * 60 * 1000
const MAX_LINES = 10

type DigestSender = typeof sendChannelDigestEmail
let send: DigestSender = sendChannelDigestEmail

export function localHour(now: Date, timezone: string | null | undefined): number {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).find((p) => p.type === 'hour')?.value
    return Number(h ?? now.getUTCHours())
  } catch {
    return now.getUTCHours()
  }
}

export function isDigestDue(row: any, now = new Date()): boolean {
  if (row?.emailDigest !== 'daily') return false
  if (row.lastDigestAt && now.getTime() - new Date(row.lastDigestAt).getTime() < MIN_GAP_MS) return false
  return localHour(now, row.timezone) === DIGEST_LOCAL_HOUR
}

export async function buildDigest(row: any, now = new Date()) {
  const since = new Date(Math.max(
    row.lastDigestAt ? new Date(row.lastDigestAt).getTime() : 0,
    now.getTime() - 24 * 60 * 60 * 1000,
  ))
  const items = await db.chatInboxItem.findMany({
    where: { workspaceId: row.workspaceId, userId: row.userId, readAt: null, createdAt: { gt: since } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const dmMembers = await db.conversationMember.findMany({
    where: {
      userId: row.userId,
      muted: false,
      conversation: { workspaceId: row.workspaceId, kind: { in: ['dm', 'group_dm'] }, archivedAt: null },
    },
    select: { conversationId: true, lastReadSeq: true },
  })
  let dmCount = 0
  const dmLines: string[] = []
  for (const m of dmMembers) {
    const unread = await db.conversationMessage.findMany({
      where: {
        conversationId: m.conversationId,
        seq: { gt: m.lastReadSeq ?? 0 },
        createdAt: { gt: since },
        deletedAt: null,
        threadRootId: null,
        authorType: { in: ['user', 'agent'] },
        NOT: { authorUserId: row.userId },
      },
      include: { authorUser: { select: { name: true, email: true } } },
      orderBy: { seq: 'desc' },
      take: 3,
    })
    if (!unread.length) continue
    dmCount += unread.length
    const who = unread[0].authorUser?.name || unread[0].authorUser?.email || unread[0].authorAgentRef?.name || 'Someone'
    dmLines.push(`• ${who} sent you ${unread.length === 3 ? 'several messages' : unread.length === 1 ? 'a message' : `${unread.length} messages`}`)
  }
  const itemLines = items.map((i: any) => `• ${i.title}: ${String(i.preview).slice(0, 120)}`)
  const lines = [...dmLines, ...itemLines]
  const total = items.length + dmCount
  return { total, lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) }
}

function countLabel(n: number): string {
  return n === 1 ? '1 unread update' : `${n} unread updates`
}

/** One pass over opted-in people. Returns how many emails were sent. */
export async function runDigestPass(now = new Date()): Promise<number> {
  const rows = await db.chatUserSettings.findMany({ where: { emailDigest: 'daily' }, take: 5000 })
  let sent = 0
  for (const row of rows) {
    if (!isDigestDue(row, now)) continue
    if (!nativeChatEnabled(await getWorkspaceChatConfig(row.workspaceId))) continue
    try {
      const digest = await buildDigest(row, now)
      await db.chatUserSettings.update({ where: { id: row.id }, data: { lastDigestAt: now } })
      if (!digest.total) continue
      const [user, workspace] = await Promise.all([
        db.user.findUnique({ where: { id: row.userId }, select: { email: true } }),
        db.workspace.findUnique({ where: { id: row.workspaceId }, select: { name: true } }),
      ])
      if (!user?.email) continue
      const base = getFrontendUrl().replace(/\/$/, '')
      const summary = digest.lines.join('\n') + (digest.more ? `\n…and ${digest.more} more` : '')
      const result = await send({
        to: user.email,
        workspaceName: workspace?.name ?? 'your workspace',
        countLabel: countLabel(digest.total),
        summary,
        channelsUrl: `${base}/c/inbox`,
        settingsUrl: `${base}/c/settings`,
      })
      if (result.success) sent++
    } catch (err: any) {
      console.warn('[chat-digest] failed for', row.userId, err?.message)
    }
  }
  return sent
}

export function _setDigestSenderForTests(sender: DigestSender | null): void {
  send = sender ?? sendChannelDigestEmail
}
