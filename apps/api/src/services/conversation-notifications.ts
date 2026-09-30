// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mention, DM, and thread-reply notifications for channel messages.
 *
 * People active in the workspace on any device get an in-app/desktop alert
 * over the realtime socket instead of a phone push; everyone else gets a push.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { sendPushToUser } from '../lib/push-notifications'
import { collectMentionIds, renderMentionsAsText } from './conversation-mentions'
import { registerAfterPostHook } from './conversation-pipeline'
import { agentDisplayName, getWorkspaceRole, isOpenKind, type PostMessageResult } from './conversation.service'
import { getPresence } from './conversation-presence'

const db = prisma as any

export type NotificationReason = 'dm' | 'mention' | 'broadcast' | 'thread'
export const PUSH_COALESCE_MS = 15_000
const BODY_CHARS = 180

type Sender = (userId: string, payload: Parameters<typeof sendPushToUser>[1]) => Promise<void>
let sendPush: Sender = sendPushToUser
const lastPush = new Map<string, number>()

export interface NotificationRecipient {
  userId: string
  reason: NotificationReason
}

function isDirect(kind: string): boolean {
  return kind === 'dm' || kind === 'group_dm'
}

/**
 * Who should hear about a message, with the strongest reason for each.
 * Direct mentions cut through mute; broadcasts and thread follow-ups don't.
 */
export async function resolveRecipients(result: PostMessageResult): Promise<NotificationRecipient[]> {
  const { row, conversation, mentions } = result
  if (row.authorType === 'system' || conversation.kind === 'activity') return []
  if (row.authorType === 'agent' && row.agentStatus === 'running') return []

  const members = await db.conversationMember.findMany({
    where: { conversationId: conversation.id, memberType: 'user', userId: { not: null } },
    select: { userId: true, muted: true, notifyLevel: true },
  })
  const byUser = new Map<string, { muted: boolean; notifyLevel: string }>(
    members.map((m: any) => [m.userId, { muted: !!m.muted, notifyLevel: m.notifyLevel ?? 'all' }]),
  )
  const reasons = new Map<string, NotificationReason>()
  const add = (userId: string, reason: NotificationReason) => {
    if (!userId || userId === row.authorUserId || reasons.has(userId)) return
    reasons.set(userId, reason)
  }
  const quiet = (userId: string) => {
    const m = byUser.get(userId)
    return !m || m.muted || m.notifyLevel === 'none'
  }

  for (const m of mentions) {
    if (m.targetType !== 'user') continue
    const member = byUser.get(m.userId)
    if (member?.notifyLevel === 'none') continue
    if (!member && !isOpenKind(conversation.kind)) continue
    if (!member && !(await getWorkspaceRole(conversation.workspaceId, m.userId))) continue
    add(m.userId, 'mention')
  }

  if (isDirect(conversation.kind)) {
    for (const userId of byUser.keys()) if (!quiet(userId)) add(userId, 'dm')
  }

  const broadcast = mentions.find((m) => m.targetType === 'channel' || m.targetType === 'here')
  if (broadcast && !isDirect(conversation.kind)) {
    let ids = [...byUser.keys()].filter((id) => !quiet(id))
    if (broadcast.targetType === 'here') {
      const presence = await getPresence(conversation.workspaceId, ids)
      ids = ids.filter((id) => presence[id] === 'active')
    }
    for (const id of ids) add(id, 'broadcast')
  }

  if (row.threadRootId) {
    const [root, repliers] = await Promise.all([
      db.conversationMessage.findUnique({ where: { id: row.threadRootId }, select: { authorUserId: true } }),
      db.conversationMessage.findMany({
        where: { threadRootId: row.threadRootId, authorUserId: { not: null }, deletedAt: null },
        select: { authorUserId: true },
        distinct: ['authorUserId'],
        take: 50,
      }),
    ])
    const followers = [root?.authorUserId, ...repliers.map((r: any) => r.authorUserId)].filter(Boolean) as string[]
    for (const id of followers) if (!quiet(id)) add(id, 'thread')
  }

  return [...reasons].map(([userId, reason]) => ({ userId, reason }))
}

async function describe(result: PostMessageResult) {
  const { row, conversation } = result
  const author = row.authorType === 'agent'
    ? row.authorAgentRef?.name ?? (await agentDisplayName(conversation.workspaceId, row.authorAgentRef?.projectId ?? null))
    : row.authorUser?.name || row.authorUser?.email || row.blocks?.externalAuthor?.name || 'Someone'
  const ids = collectMentionIds([row.text])
  const [users, projects] = await Promise.all([
    ids.userIds.length ? db.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, name: true, email: true } }) : [],
    ids.projectIds.length ? db.project.findMany({ where: { id: { in: ids.projectIds } }, select: { id: true, name: true } }) : [],
  ])
  const text = renderMentionsAsText(row.text ?? '', {
    users: new Map(users.map((u: any) => [u.id, u.name || u.email])),
    projects: new Map(projects.map((p: any) => [p.id, p.name])),
    workspaceAgentName: await agentDisplayName(conversation.workspaceId, null),
  }).replace(/\s+/g, ' ').trim()
  const attachments = row.attachments?.length ? `📎 ${row.attachments.length} file${row.attachments.length > 1 ? 's' : ''}` : ''
  const body = (text || attachments || 'New message').slice(0, BODY_CHARS)
  const where = isDirect(conversation.kind) ? null : `#${conversation.slug ?? conversation.name ?? 'channel'}`
  const title = !where ? author : row.threadRootId ? `${author} replied in ${where}` : `${author} in ${where}`
  return { title, body }
}

export async function notifyForMessage(result: PostMessageResult): Promise<NotificationRecipient[]> {
  if (result.duplicate) return []
  const recipients = await resolveRecipients(result)
  if (!recipients.length) return []
  const { row, conversation } = result
  const { title, body } = await describe(result)
  const presence = await getPresence(conversation.workspaceId, recipients.map((r) => r.userId))
  const data = {
    conversationId: conversation.id,
    messageId: row.id,
    threadRootId: row.threadRootId ?? null,
    workspaceId: conversation.workspaceId,
  }

  for (const { userId, reason } of recipients) {
    if (presence[userId] === 'active') {
      publishConversationEvent(
        conversation.workspaceId,
        { type: 'notification', ...data, reason, title, body },
        [userId],
      )
      continue
    }
    const key = `${userId}:${conversation.id}`
    const now = Date.now()
    if (now - (lastPush.get(key) ?? 0) < PUSH_COALESCE_MS) continue
    if (lastPush.size > 10_000) {
      for (const [k, t] of lastPush) if (now - t >= PUSH_COALESCE_MS) lastPush.delete(k)
    }
    lastPush.set(key, now)
    void sendPush(userId, { title, body, type: 'channel-message', channelId: 'messages', data: { ...data, reason } })
  }
  return recipients
}

let registered = false

export function registerConversationNotifications(): void {
  if (registered) return
  registered = true
  registerAfterPostHook(async (result) => {
    await notifyForMessage(result)
  })
}

export function _setPushSenderForTests(sender: Sender | null): void {
  sendPush = sender ?? sendPushToUser
  lastPush.clear()
}
