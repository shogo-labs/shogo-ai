// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins, saved items, synced drafts, scheduled messages, and reminders.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { sendPushToUser } from '../lib/push-notifications'
import {
  ConversationError,
  MESSAGE_INCLUDE,
  canRead,
  conversationAudience,
  getWorkspaceRole,
  joinConversation,
  loadAccess,
  postMessage,
  requirePost,
  serializeMessage,
} from './conversation.service'
import { afterMessagePosted } from './conversation-pipeline'
import { createInboxItems } from './chat-inbox'
import { getSettingsRow, isSilenced } from './chat-settings'
import { getPresence } from './conversation-presence'
import { parseRemindCommand } from './chat-remind-parse'

const db = prisma as any

const MAX_DRAFT_CHARS = 40_000
const MAX_SCHEDULE_AHEAD_MS = 120 * 86_400_000
const MIN_SCHEDULE_AHEAD_MS = 5_000
const MAX_PINS = 100

async function loadMessage(messageId: string) {
  const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
  if (!row || row.deletedAt) throw new ConversationError(404, 'not_found', 'Message not found')
  return row
}

function conversationRef(c: any) {
  return { id: c.id, kind: c.kind, name: c.name ?? null, slug: c.slug ?? null }
}

// ─── Pins ────────────────────────────────────────────────────────────────────

export async function setPinned(messageId: string, userId: string, on: boolean) {
  const row = await loadMessage(messageId)
  const access = await requirePost(row.conversationId, userId, { threadReply: true })
  if (on) {
    const count = await db.conversationPin.count({ where: { conversationId: row.conversationId } })
    if (count >= MAX_PINS) throw new ConversationError(400, 'too_many_pins', `A conversation can have at most ${MAX_PINS} pins`)
    const existing = await db.conversationPin.findFirst({ where: { messageId }, select: { id: true } })
    if (!existing) {
      try {
        await db.conversationPin.create({ data: { conversationId: row.conversationId, messageId, pinnedById: userId } })
      } catch {
        // Concurrent pin; the unique index already holds it.
      }
    }
  } else {
    await db.conversationPin.deleteMany({ where: { messageId } })
  }
  const full = await db.conversationMessage.findUnique({ where: { id: messageId }, include: MESSAGE_INCLUDE })
  const message = serializeMessage(full)
  publishConversationEvent(
    access.conversation.workspaceId,
    { type: 'message.updated', conversationId: row.conversationId, message },
    await conversationAudience(access.conversation),
  )
  return message
}

export async function listPins(conversationId: string, userId: string) {
  const access = await loadAccess(conversationId, userId)
  if (!canRead(access)) throw new ConversationError(403, 'forbidden', 'No access to this conversation')
  const pins = await db.conversationPin.findMany({
    where: { conversationId, message: { deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    include: { message: { include: MESSAGE_INCLUDE } },
  })
  return pins.map((p: any) => serializeMessage(p.message))
}

// ─── Saved ───────────────────────────────────────────────────────────────────

export async function setSaved(messageId: string, userId: string, on: boolean) {
  const row = await loadMessage(messageId)
  const access = await loadAccess(row.conversationId, userId)
  if (!canRead(access)) throw new ConversationError(403, 'forbidden', 'No access to this conversation')
  if (on) {
    const existing = await db.savedMessage.findFirst({ where: { userId, messageId }, select: { id: true } })
    if (!existing) {
      try {
        await db.savedMessage.create({ data: { userId, messageId } })
      } catch {
        // Concurrent save; the unique index already holds it.
      }
    }
  } else {
    await db.savedMessage.deleteMany({ where: { userId, messageId } })
  }
  publishConversationEvent(access.conversation.workspaceId, { type: 'saved.changed', messageId, saved: on }, [userId])
  return { saved: on }
}

/** Saved messages the viewer can still read, newest save first. */
export async function listSaved(workspaceId: string, userId: string, opts: { limit?: number } = {}) {
  const rows = await db.savedMessage.findMany({
    where: { userId, message: { workspaceId, deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 100, 1), 200),
    include: { message: { include: { ...MESSAGE_INCLUDE, conversation: true } } },
  })
  const out = []
  for (const r of rows) {
    const access = await loadAccess(r.message.conversationId, userId).catch(() => null)
    if (!access || !canRead(access)) continue
    out.push({ savedAt: r.createdAt, message: serializeMessage(r.message), conversation: conversationRef(r.message.conversation) })
  }
  return out
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

export async function putDraft(conversationId: string, userId: string, text: string, threadRootId?: string | null) {
  const access = await loadAccess(conversationId, userId)
  if (!canRead(access)) throw new ConversationError(403, 'forbidden', 'No access to this conversation')
  const root = threadRootId || ''
  const clean = (text ?? '').slice(0, MAX_DRAFT_CHARS)
  const key = { userId_conversationId_threadRootId: { userId, conversationId, threadRootId: root } }
  if (!clean.trim()) {
    await db.conversationDraft.deleteMany({ where: { userId, conversationId, threadRootId: root } })
  } else {
    await db.conversationDraft.upsert({
      where: key,
      create: { userId, conversationId, threadRootId: root, text: clean },
      update: { text: clean },
    })
  }
  const draft = { conversationId, threadRootId: root || null, text: clean.trim() ? clean : '', updatedAt: new Date().toISOString() }
  publishConversationEvent(access.conversation.workspaceId, { type: 'draft.changed', draft }, [userId])
  return draft
}

export async function listDrafts(workspaceId: string, userId: string) {
  const rows = await db.conversationDraft.findMany({
    where: { userId, conversation: { workspaceId } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { conversation: { select: { id: true, kind: true, name: true, slug: true } } },
  })
  return rows.map((d: any) => ({
    conversationId: d.conversationId,
    threadRootId: d.threadRootId || null,
    text: d.text,
    updatedAt: new Date(d.updatedAt).toISOString(),
    conversation: conversationRef(d.conversation),
  }))
}

// ─── Scheduled messages ──────────────────────────────────────────────────────

function serializeScheduled(row: any) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId ?? null,
    alsoSentToChannel: !!row.alsoSentToChannel,
    text: row.text,
    sendAt: new Date(row.sendAt).toISOString(),
    status: row.status,
    sentMessageId: row.sentMessageId ?? null,
    error: row.error ?? null,
    conversation: row.conversation ? conversationRef(row.conversation) : null,
  }
}

function validSendAt(raw: unknown, now = Date.now()): Date {
  const at = new Date(raw as any)
  if (Number.isNaN(at.getTime())) throw new ConversationError(400, 'invalid_schedule', 'sendAt must be a date')
  if (at.getTime() < now + MIN_SCHEDULE_AHEAD_MS) throw new ConversationError(400, 'invalid_schedule', 'Pick a time in the future')
  if (at.getTime() > now + MAX_SCHEDULE_AHEAD_MS) throw new ConversationError(400, 'invalid_schedule', 'Schedule at most 120 days ahead')
  return at
}

export async function scheduleMessage(input: {
  conversationId: string
  userId: string
  text: string
  sendAt: unknown
  threadRootId?: string | null
  alsoSentToChannel?: boolean
}) {
  const text = (input.text ?? '').trim()
  if (!text) throw new ConversationError(400, 'empty_message', 'Message is empty')
  const access = await requirePost(input.conversationId, input.userId, { threadReply: !!input.threadRootId })
  const row = await db.scheduledMessage.create({
    data: {
      workspaceId: access.conversation.workspaceId,
      conversationId: input.conversationId,
      userId: input.userId,
      threadRootId: input.threadRootId || null,
      alsoSentToChannel: !!input.alsoSentToChannel && !!input.threadRootId,
      text,
      sendAt: validSendAt(input.sendAt),
    },
    include: { conversation: true },
  })
  return serializeScheduled(row)
}

export async function listScheduled(workspaceId: string, userId: string) {
  const rows = await db.scheduledMessage.findMany({
    where: { workspaceId, userId, status: { in: ['pending', 'failed'] } },
    orderBy: { sendAt: 'asc' },
    take: 200,
    include: { conversation: true },
  })
  return rows.map(serializeScheduled)
}

async function ownScheduled(id: string, userId: string) {
  const row = await db.scheduledMessage.findUnique({ where: { id } })
  if (!row || row.userId !== userId) throw new ConversationError(404, 'not_found', 'Scheduled message not found')
  return row
}

export async function updateScheduled(id: string, userId: string, patch: { text?: unknown; sendAt?: unknown }) {
  const row = await ownScheduled(id, userId)
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new ConversationError(400, 'not_pending', 'This message was already sent or cancelled')
  }
  const data: Record<string, unknown> = { status: 'pending', error: null }
  if (typeof patch.text === 'string') {
    if (!patch.text.trim()) throw new ConversationError(400, 'empty_message', 'Message is empty')
    data.text = patch.text.trim()
  }
  if (patch.sendAt !== undefined) data.sendAt = validSendAt(patch.sendAt)
  const { count } = await db.scheduledMessage.updateMany({ where: { id, status: row.status }, data })
  if (!count) throw new ConversationError(409, 'conflict', 'This message is being sent')
  return serializeScheduled(await db.scheduledMessage.findUnique({ where: { id }, include: { conversation: true } }))
}

export async function cancelScheduled(id: string, userId: string) {
  const row = await ownScheduled(id, userId)
  const { count } = await db.scheduledMessage.updateMany({
    where: { id, status: { in: ['pending', 'failed'] } },
    data: { status: 'cancelled' },
  })
  if (!count && row.status === 'sent') throw new ConversationError(400, 'not_pending', 'This message was already sent')
  return { cancelled: true }
}

/** Send everything that's due. Each row is claimed before posting so it goes out once. */
export async function sendDueScheduledMessages(now = new Date()): Promise<number> {
  const due = await db.scheduledMessage.findMany({
    where: { status: 'pending', sendAt: { lte: now } },
    orderBy: { sendAt: 'asc' },
    take: 100,
  })
  let sent = 0
  for (const row of due) {
    const { count } = await db.scheduledMessage.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'sent' } })
    if (!count) continue
    try {
      const access = await requirePost(row.conversationId, row.userId, { threadReply: !!row.threadRootId })
      if (!access.membership && access.conversation.kind === 'public') await joinConversation(row.conversationId, row.userId)
      const result = await postMessage({
        conversationId: row.conversationId,
        text: row.text,
        authorType: 'user',
        authorUserId: row.userId,
        threadRootId: row.threadRootId,
        alsoSentToChannel: row.alsoSentToChannel,
        clientMsgId: `scheduled:${row.id}`,
      })
      await db.scheduledMessage.update({ where: { id: row.id }, data: { sentMessageId: result.row.id, error: null } })
      void afterMessagePosted(result, { actorUserId: row.userId, origin: 'app' })
      sent++
    } catch (err: any) {
      await db.scheduledMessage.update({
        where: { id: row.id },
        data: { status: 'failed', error: String(err?.message ?? 'Could not send').slice(0, 500) },
      })
      publishConversationEvent(row.workspaceId, { type: 'scheduled.failed', id: row.id, error: err?.message ?? null }, [row.userId])
    }
  }
  return sent
}

// ─── Reminders ───────────────────────────────────────────────────────────────

function serializeReminder(row: any) {
  return {
    id: row.id,
    text: row.text,
    remindAt: new Date(row.remindAt).toISOString(),
    status: row.status,
    messageId: row.messageId ?? null,
    conversationId: row.conversationId ?? null,
    firedAt: row.firedAt ? new Date(row.firedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

export async function createReminder(input: {
  workspaceId: string
  userId: string
  text?: string
  remindAt?: unknown
  command?: string
  messageId?: string | null
}) {
  if (!(await getWorkspaceRole(input.workspaceId, input.userId))) throw new ConversationError(403, 'forbidden', 'No access')
  let text = (input.text ?? '').trim()
  let remindAt: Date | null = input.remindAt ? new Date(input.remindAt as any) : null
  if (input.command) {
    const settings = await getSettingsRow(input.workspaceId, input.userId)
    const parsed = parseRemindCommand(input.command, new Date(), settings?.timezone)
    if (!parsed) {
      throw new ConversationError(400, 'invalid_reminder', 'Try something like “/remind me to review the PR in 2 hours” or “… tomorrow at 9am”')
    }
    text = parsed.text
    remindAt = parsed.remindAt
  }
  let conversationId: string | null = null
  if (input.messageId) {
    const msg = await loadMessage(input.messageId)
    const access = await loadAccess(msg.conversationId, input.userId)
    if (!canRead(access) || access.conversation.workspaceId !== input.workspaceId) {
      throw new ConversationError(403, 'forbidden', 'No access to this message')
    }
    conversationId = msg.conversationId
    if (!text) text = (msg.text ?? '').replace(/<[@#!][^>]*>/g, '').trim().slice(0, 200) || 'this message'
  }
  if (!text) throw new ConversationError(400, 'invalid_reminder', 'What should I remind you about?')
  if (!remindAt || Number.isNaN(remindAt.getTime()) || remindAt.getTime() <= Date.now()) {
    throw new ConversationError(400, 'invalid_reminder', 'Pick a time in the future')
  }
  const row = await db.chatReminder.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      text: text.slice(0, 1000),
      remindAt,
      messageId: input.messageId ?? null,
      conversationId,
    },
  })
  return serializeReminder(row)
}

export async function listReminders(workspaceId: string, userId: string, opts: { includeDone?: boolean } = {}) {
  const rows = await db.chatReminder.findMany({
    where: { workspaceId, userId, status: { in: opts.includeDone ? ['pending', 'fired', 'done'] : ['pending', 'fired'] } },
    orderBy: { remindAt: 'asc' },
    take: 200,
  })
  return rows.map(serializeReminder)
}

export async function updateReminder(id: string, userId: string, patch: { status?: unknown; remindAt?: unknown }) {
  const row = await db.chatReminder.findUnique({ where: { id } })
  if (!row || row.userId !== userId) throw new ConversationError(404, 'not_found', 'Reminder not found')
  const data: Record<string, unknown> = {}
  if (patch.remindAt !== undefined) {
    const at = new Date(patch.remindAt as any)
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      throw new ConversationError(400, 'invalid_reminder', 'Pick a time in the future')
    }
    data.remindAt = at
    data.status = 'pending'
    data.firedAt = null
  }
  if (patch.status === 'done' || patch.status === 'cancelled') data.status = patch.status
  return serializeReminder(await db.chatReminder.update({ where: { id }, data }))
}

type Pusher = typeof sendPushToUser
let pushReminder: Pusher = sendPushToUser

export async function fireDueReminders(now = new Date()): Promise<number> {
  const due = await db.chatReminder.findMany({
    where: { status: 'pending', remindAt: { lte: now } },
    orderBy: { remindAt: 'asc' },
    take: 200,
  })
  let fired = 0
  for (const row of due) {
    const { count } = await db.chatReminder.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'fired', firedAt: now },
    })
    if (!count) continue
    fired++
    const title = 'Reminder'
    await createInboxItems([{
      workspaceId: row.workspaceId,
      userId: row.userId,
      kind: 'reminder',
      conversationId: row.conversationId,
      messageId: row.messageId,
      title,
      preview: row.text,
    }])
    const settings = await getSettingsRow(row.workspaceId, row.userId)
    if (isSilenced(settings, now)) continue
    const presence = await getPresence(row.workspaceId, [row.userId])
    const data = {
      conversationId: row.conversationId,
      messageId: row.messageId,
      threadRootId: null,
      workspaceId: row.workspaceId,
    }
    if (presence[row.userId] === 'active') {
      publishConversationEvent(row.workspaceId, { type: 'notification', ...data, reason: 'reminder', title, body: row.text }, [row.userId])
    } else {
      void pushReminder(row.userId, { title, body: row.text, type: 'channel-message', channelId: 'messages', audience: 'chat', data: { ...data, reason: 'reminder' } })
    }
  }
  return fired
}

export function _setReminderPushForTests(fn: Pusher | null): void {
  pushReminder = fn ?? sendPushToUser
}
