// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mention, DM, and thread-reply notifications for channel messages.
 *
 * Every open client gets an alert over the realtime socket; people not active
 * in the workspace on any device also get a phone push.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { sendPushToUser } from '../lib/push-notifications'
import { markdownToPlainText, renderMentionsAsText } from './conversation-mentions'
import { loadMentionNames } from './conversation-agent-dispatcher'
import { registerAfterPostHook } from './conversation-pipeline'
import {
  agentDisplayName, onReactionAdded,
  type PostMessageResult, type ReactionAddedEvent,
} from './conversation.service'
import { getPresence } from './conversation-presence'
import { getSettingsRows, isSilenced, parseKeywords, type MessageSound, type MobilePushDelay } from './chat-settings'
import { createInboxItems } from './chat-inbox'
import { interrupts } from './conversation-message-kind'
import { approvalPushFor } from './approval-push'
import { liveActivityApprovalOpened } from './approval-live-activity'
import { clearDelayedPushes, delayedPushCount, scheduleDelayedPush as queueDelayedPush } from './push-delay-queue'

const db = prisma as any

export type NotificationReason = 'dm' | 'mention' | 'keyword' | 'broadcast' | 'thread' | 'message'
export const PUSH_COALESCE_MS = 15_000
const BODY_CHARS = 180
const INBOX_REASONS = new Set<NotificationReason>(['mention', 'keyword', 'broadcast', 'thread'])

/** How long a phone waits before a push, once the person has gone away. */
const PUSH_DELAY_MS: Record<MobilePushDelay, number> = {
  immediate: 0,
  inactive: 0,
  inactive_5m: 5 * 60_000,
  inactive_10m: 10 * 60_000,
}

type Sender = (userId: string, payload: Parameters<typeof sendPushToUser>[1]) => Promise<void>
let sendPush: Sender = sendPushToUser
const lastPush = new Map<string, number>()

export interface NotificationRecipient {
  userId: string
  reason: NotificationReason
  /** DND or quiet hours: record it in the inbox but don't alert. */
  silenced?: boolean
  /** The recipient's message sound; `off` keeps phone pushes silent. */
  messageSound?: MessageSound
  /** Direct messages also land in the Activity inbox. */
  dmInActivity?: boolean
  /** When the phone push goes out; `immediate` pushes even while the person is active. */
  mobilePushDelay?: MobilePushDelay
}

function pushDelayOf(raw: unknown): MobilePushDelay {
  return typeof raw === 'string' && raw in PUSH_DELAY_MS ? (raw as MobilePushDelay) : 'inactive'
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
    // Mentioning someone who isn't in this channel never notifies them, public or
    // private: channel notifications are scoped to members, same as Slack. The
    // composer instead offers to add them (see team-chat-mention-nudge.ts).
    if (!member) continue
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
    // Followers: whoever started the thread, everyone who replied, and everyone
    // @mentioned in it, as in Slack. Non-members and muted members are skipped by `quiet`.
    const inThread = { OR: [{ id: row.threadRootId }, { threadRootId: row.threadRootId }], deletedAt: null }
    const [authors, mentioned] = await Promise.all([
      db.conversationMessage.findMany({
        where: { ...inThread, authorUserId: { not: null } },
        select: { authorUserId: true },
        distinct: ['authorUserId'],
        take: 50,
      }),
      db.conversationMention.findMany({
        where: { targetType: 'user', targetUserId: { not: null }, message: inThread },
        select: { targetUserId: true },
        distinct: ['targetUserId'],
        take: 50,
      }),
    ])
    const followers = [
      ...authors.map((r: any) => r.authorUserId),
      ...mentioned.map((m: any) => m.targetUserId),
    ].filter(Boolean) as string[]
    for (const id of followers) if (!quiet(id)) add(id, 'thread')
  }

  if (!direct && !row.threadRootId) {
    for (const [userId, m] of byUser) if (!quiet(userId) && m.level === 'all') add(userId, 'message')
  }

  // Routine agent updates (status, result) only reach people who asked for every message.
  // Decisions and alerts keep the reasons above, so thread followers hear about them.
  const quietKind = row.authorType === 'agent' && !interrupts(row.blocks)
  const now = new Date()
  return [...reasons]
    .filter(([userId]) => !quietKind || (byUser.get(userId)?.level === 'all' && !byUser.get(userId)?.muted))
    .map(([userId, reason]) => ({
      userId,
      reason,
      silenced: isSilenced(settings.get(userId), now),
      messageSound: settings.get(userId)?.messageSound === 'off' ? 'off' : 'default',
      dmInActivity: settings.get(userId)?.dmInActivity === true,
      mobilePushDelay: pushDelayOf(settings.get(userId)?.mobilePushDelay),
    }))
}

/**
 * Preview text for a notification: mention tokens resolved to names, then
 * flattened to plain text.
 *
 * `renderMentionsAsText` falls back to `@someone` / `@group` / `@agent` /
 * `#channel` for every token whose id it was not handed, so a preview built
 * without the name lookup shows placeholders instead of the people tagged.
 */
async function notificationText(text: string, workspaceId: string): Promise<string> {
  return markdownToPlainText(renderMentionsAsText(text, await loadMentionNames(workspaceId, [text])))
}

async function describe(result: PostMessageResult) {
  const { row, conversation } = result
  const author = row.authorType === 'agent'
    ? row.authorAgentRef?.name ?? (await agentDisplayName(conversation.workspaceId, row.authorAgentRef?.projectId ?? null))
    : row.authorUser?.name || row.authorUser?.email || row.blocks?.externalAuthor?.name || 'Someone'
  const text = await notificationText(row.text ?? '', conversation.workspaceId)
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
  const approval = approvalPushFor(row)
  const data = {
    conversationId: conversation.id,
    messageId: row.id,
    threadRootId: row.threadRootId ?? null,
    workspaceId: conversation.workspaceId,
  }

  await createInboxItems(recipients
    .filter((r) => INBOX_REASONS.has(r.reason) || (r.reason === 'dm' && r.dmInActivity === true))
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

  for (const { userId, reason, silenced, messageSound, mobilePushDelay = 'inactive' } of recipients) {
    if (silenced) continue
    // The phone plays the system sound only when the person wants message sounds.
    const sound: 'default' | null = messageSound === 'off' ? null : 'default'
    // Every open client gets the alert and decides locally whether to show it
    // (a backgrounded tab with permission still can). The push is only for
    // when no device is in active use, unless the person asked for every push.
    publishConversationEvent(
      conversation.workspaceId,
      { type: 'notification', ...data, reason, title, body },
      [userId],
    )
    if (presence[userId] === 'active' && mobilePushDelay !== 'immediate') continue
    // An approval waits on a person, so it is never folded into the last push
    // for the channel, and its notification carries Approve and Deny buttons.
    if (approval) {
      void sendPush(userId, {
        title: approval.title,
        body: approval.body,
        type: 'agent-approval',
        channelId: 'messages',
        audience: 'chat',
        categoryId: approval.categoryId,
        sound,
        data: { ...data, reason, ...approval.data },
      })
      void liveActivityApprovalOpened(userId, approval)
      continue
    }
    const key = `${userId}:${conversation.id}`
    const now = Date.now()
    if (now - (lastPush.get(key) ?? 0) < PUSH_COALESCE_MS) continue
    if (lastPush.size > 10_000) {
      for (const [k, t] of lastPush) if (now - t >= PUSH_COALESCE_MS) lastPush.delete(k)
    }
    const payload = { title, body, type: 'channel-message' as const, channelId: 'messages', audience: 'chat' as const, sound, data: { ...data, reason } }
    const wait = PUSH_DELAY_MS[mobilePushDelay]
    if (wait > 0) {
      scheduleDelayedPush(userId, conversation.id, conversation.workspaceId, wait, payload)
      continue
    }
    lastPush.set(key, now)
    void sendPush(userId, payload)
  }
  return recipients
}

/**
 * Holds a phone push for `waitMs`, then sends it only if the person is still
 * away. Reading the conversation first cancels it (see `cancelDelayedPushes`).
 */
function scheduleDelayedPush(
  userId: string,
  conversationId: string,
  workspaceId: string,
  waitMs: number,
  payload: Parameters<typeof sendPushToUser>[1],
): void {
  const key = `${userId}:${conversationId}`
  queueDelayedPush(userId, conversationId, waitMs, async () => {
    const presence = await getPresence(workspaceId, [userId])
    if (presence[userId] === 'active') return
    lastPush.set(key, Date.now())
    await sendPush(userId, payload)
  })
}

export function _delayedPushCountForTests(): number {
  return delayedPushCount()
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
  const preview = (await notificationText(message.text ?? '', conversation.workspaceId)) || 'your message'
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

/**
 * An agent asked these people something they weren't tagged in (or the post
 * that asked it was too quiet to notify). Never folded into a channel's last
 * push, since someone is waiting on the answer.
 */
export async function notifyQuestion(input: {
  conversation: any
  row: any
  userIds: string[]
  title: string
  body: string
}): Promise<void> {
  const { conversation, row } = input
  const settings = await getSettingsRows(conversation.workspaceId, input.userIds)
  const presence = await getPresence(conversation.workspaceId, input.userIds)
  const now = new Date()
  const body = (await notificationText(input.body, conversation.workspaceId)).slice(0, BODY_CHARS)
  const data = {
    conversationId: conversation.id,
    messageId: row.id,
    threadRootId: row.threadRootId ?? null,
    workspaceId: conversation.workspaceId,
    reason: 'question',
  }
  for (const userId of input.userIds) {
    if (isSilenced(settings.get(userId), now)) continue
    publishConversationEvent(conversation.workspaceId, { type: 'notification', ...data, title: input.title, body }, [userId])
    if (presence[userId] === 'active') continue
    void sendPush(userId, { title: input.title, body, type: 'agent-question', channelId: 'messages', audience: 'chat', data })
  }
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
  clearDelayedPushes()
}
