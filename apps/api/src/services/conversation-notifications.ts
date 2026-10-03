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
import { collectMentionIds, groupNames, renderMentionsAsText } from './conversation-mentions'
import { registerAfterPostHook } from './conversation-pipeline'
import {
  agentDisplayName, getWorkspaceRole, isOpenKind, onReactionAdded,
  type PostMessageResult, type ReactionAddedEvent,
} from './conversation.service'
import { getPresence } from './conversation-presence'
import { getSettingsRows, isSilenced, parseKeywords } from './chat-settings'
import { createInboxItems } from './chat-inbox'

const db = prisma as any

export type NotificationReason = 'dm' | 'mention' | 'keyword' | 'broadcast' | 'thread' | 'message'
export const PUSH_COALESCE_MS = 15_000
const BODY_CHARS = 180
const INBOX_REASONS = new Set<NotificationReason>(['mention', 'keyword', 'broadcast', 'thread'])

type Sender = (userId: string, payload: Parameters<typeof sendPushToUser>[1]) => Promise<void>
let sendPush: Sender = sendPushToUser
const lastPush = new Map<string, number>()

export interface NotificationRecipient {
  userId: string
  reason: NotificationReason
  /** DND or quiet hours: record it in the inbox but don't alert. */
  silenced?: boolean
}

function isDirect(kind: string): boolean {
  return kind === 'dm' || kind === 'group_dm'
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchesKeyword(text: string, keywords: string[]): boolean {
  if (!text || !keywords.length) return false
  const plain = text.replace(/<[@#!][^>]*>/g, ' ')
  return keywords.some((k) =>
    new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(k)}($|[^\\p{L}\\p{N}_])`, 'iu').test(plain))
}

/**
 * Who should hear about a message, with the strongest reason for each.
 * Direct mentions cut through mute; everything else respects mute and the
 * member's effective level (their channel override, else their workspace
 * default; DMs default to every message).
 */
export async function resolveRecipients(result: PostMessageResult): Promise<NotificationRecipient[]> {
  const { row, conversation, mentions } = result
  if (row.authorType === 'system' || conversation.kind === 'activity') return []
  if (row.authorType === 'agent' && row.agentStatus === 'running') return []
  const direct = isDirect(conversation.kind)

  const members = await db.conversationMember.findMany({
    where: { conversationId: conversation.id, memberType: 'user', userId: { not: null } },
    select: { userId: true, muted: true, notifyLevel: true },
  })
  const mentionedIds = mentions.filter((m) => m.targetType === 'user').map((m) => m.userId)
  const settings = await getSettingsRows(
    conversation.workspaceId,
    [...new Set([...members.map((m: any) => m.userId), ...mentionedIds])],
  )
  const levelFor = (userId: string, stored: string | null | undefined): string => {
    if (stored === 'all' || stored === 'mentions' || stored === 'none') return stored
    if (direct) return 'all'
    return settings.get(userId)?.notifyDefault ?? 'mentions'
  }
  const byUser = new Map<string, { muted: boolean; level: string }>(
    members.map((m: any) => [m.userId, { muted: !!m.muted, level: levelFor(m.userId, m.notifyLevel) }]),
  )
  const reasons = new Map<string, NotificationReason>()
  const add = (userId: string, reason: NotificationReason) => {
    if (!userId || userId === row.authorUserId || reasons.has(userId)) return
    reasons.set(userId, reason)
  }
  const quiet = (userId: string) => {
    const m = byUser.get(userId)
    return !m || m.muted || m.level === 'none'
  }

  for (const m of mentions) {
    if (m.targetType !== 'user') continue
    const member = byUser.get(m.userId)
    if (member?.level === 'none') continue
    if (!member && !isOpenKind(conversation.kind)) continue
    if (!member && !(await getWorkspaceRole(conversation.workspaceId, m.userId))) continue
    add(m.userId, 'mention')
  }

  if (direct) {
    for (const userId of byUser.keys()) if (!quiet(userId)) add(userId, 'dm')
  }

  if (!direct && row.text) {
    for (const userId of byUser.keys()) {
      if (quiet(userId)) continue
      if (matchesKeyword(row.text, parseKeywords(settings.get(userId)?.keywords))) add(userId, 'keyword')
    }
  }

  const broadcast = mentions.find((m) => m.targetType === 'channel' || m.targetType === 'here')
  if (broadcast && !direct) {
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

  if (!direct && !row.threadRootId) {
    for (const [userId, m] of byUser) if (!quiet(userId) && m.level === 'all') add(userId, 'message')
  }

  const now = new Date()
  return [...reasons].map(([userId, reason]) => ({ userId, reason, silenced: isSilenced(settings.get(userId), now) }))
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
    groups: await groupNames(db, conversation.workspaceId, ids.groupIds),
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

  await createInboxItems(recipients
    .filter((r) => INBOX_REASONS.has(r.reason))
    .map((r) => ({
      workspaceId: conversation.workspaceId,
      userId: r.userId,
      kind: r.reason,
      conversationId: conversation.id,
      messageId: row.id,
      actorUserId: row.authorUserId ?? null,
      title,
      preview: body,
    })))

  for (const { userId, reason, silenced } of recipients) {
    if (silenced) continue
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
    void sendPush(userId, { title, body, type: 'channel-message', channelId: 'messages', audience: 'chat', data: { ...data, reason } })
  }
  return recipients
}

export async function notifyForReaction({ message, conversation, reactorId, emoji }: ReactionAddedEvent): Promise<void> {
  const authorId = message.authorUserId
  if (!authorId || authorId === reactorId || message.authorType !== 'user') return
  const existing = await db.chatInboxItem.findFirst({
    where: { userId: authorId, kind: 'reaction', messageId: message.id, actorUserId: reactorId, readAt: null },
    select: { id: true },
  })
  if (existing) return
  const reactor = await db.user.findUnique({ where: { id: reactorId }, select: { name: true, email: true } })
  const who = reactor?.name || reactor?.email || 'Someone'
  const preview = renderMentionsAsText(message.text ?? '').replace(/\s+/g, ' ').trim() || 'your message'
  await createInboxItems([{
    workspaceId: conversation.workspaceId,
    userId: authorId,
    kind: 'reaction',
    conversationId: conversation.id,
    messageId: message.id,
    actorUserId: reactorId,
    title: `${who} reacted ${emoji} to your message`,
    preview: preview.slice(0, BODY_CHARS),
  }])
}

let registered = false

export function registerConversationNotifications(): void {
  if (registered) return
  registered = true
  registerAfterPostHook(async (result) => {
    await notifyForMessage(result)
  })
  onReactionAdded(notifyForReaction)
}

export function _setPushSenderForTests(sender: Sender | null): void {
  sendPush = sender ?? sendPushToUser
  lastPush.clear()
}
