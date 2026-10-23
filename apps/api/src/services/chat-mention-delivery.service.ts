// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat tags that reach the chat they name (SHO-52).
 *
 * A message carrying `<@c:CHAT_ID>` is delivered into that chat as a user
 * message from the sender, prefixed with one origin line, and its agent turn
 * starts. Delivery reuses the durable queue (`ChatQueuedMessage` +
 * `dispatchNext`), which already dispatches against the target session's own
 * runtime — including `ws:<workspaceId>` runtimes, so a chat in another
 * workspace needs no extra machinery.
 *
 * Two guards keep tags from turning into a loop: a chat never tags itself, and
 * a message that arrived as a handoff (its body carries `origin`) never fans
 * out again. Nothing is posted back into the source chat automatically — the
 * source chip shows the target's status instead.
 */

import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'
import {
  chatTitleOf,
  chatScopeOf,
  resolveChatForUser,
} from '../lib/chat-mentionables'
import { mentionedChatIds, chatMentionToken } from './conversation-mentions'
import { dispatchNext } from './chat-queue-dispatcher.service'

export interface HandoffOrigin {
  handoffFromChatId?: string | null
  handoffFromUserId?: string | null
  handoffAt?: string | null
}

export interface DeliveredChatMention {
  id: string
  title: string
  workspaceId: string
  workspaceName: string
  projectId: string | null
  /** False when the target was mid-turn and the message waits in its queue. */
  started: boolean
  messageId: string
}

export interface ChatMentionDeliveryResult {
  delivered: DeliveredChatMention[]
  /** Ids that were dropped: self, unknown, archived, or not open to the sender. */
  dropped: string[]
}

/**
 * The user's typed text for the turn, from `body.text` or the last user
 * message's text parts. Used to find chat tokens on every send path.
 */
export function chatHandoffText(body: any): string {
  if (typeof body?.text === 'string' && body.text.trim()) return body.text
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const parts = Array.isArray(message.parts) ? message.parts : []
    const text = parts
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('')
    if (text) return text
  }
  return ''
}

/** True when this turn is already a handoff and must not fan out again. */
export function isChatHandoff(body: any): boolean {
  const origin = body?.origin
  return typeof origin?.handoffFromChatId === 'string' && origin.handoffFromChatId.length > 0
}

async function senderName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
  return user?.name?.trim() || user?.email || 'someone'
}

async function originLabel(sourceSessionId: string | null, userId: string): Promise<string> {
  const sender = await senderName(userId)
  if (!sourceSessionId) return `From @${sender}:`
  const source = await resolveChatForUser(userId, sourceSessionId)
  if (!source) return `From @${sender}:`
  const scope = chatScopeOf(source)
  const where = scope.workspaceName ? ` (${scope.workspaceName})` : ''
  return `From @${sender} in "${chatTitleOf(source)}"${where}:`
}

async function nextPosition(sessionId: string): Promise<number> {
  const last = await (prisma as any).chatQueuedMessage.findFirst({
    where: { sessionId, status: 'pending' },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  return (last?.position ?? 0) + 1
}

/**
 * Deliver one message into one chat and start its turn. Returns null when the
 * chat cannot be opened by `actingUserId` (or is the source chat).
 */
export async function handOffToChat(input: {
  targetChatId: string
  text: string
  actingUserId: string
  sourceSessionId?: string | null
  references?: unknown[]
}): Promise<DeliveredChatMention | null> {
  const target = await resolveChatForUser(input.actingUserId, input.targetChatId)
  if (!target) return null
  if (input.sourceSessionId && target.id === input.sourceSessionId) return null

  const body = input.text.trim()
  if (!body) return null

  const origin = await originLabel(input.sourceSessionId ?? null, input.actingUserId)
  const content = `${origin}\n\n${body}`
  const scope = chatScopeOf(target)
  const messageId = randomUUID()
  const source = input.sourceSessionId
    ? await resolveChatForUser(input.actingUserId, input.sourceSessionId)
    : null
  // The source chat rides along as a context reference so the receiving agent
  // can read what was being discussed instead of guessing from the excerpt.
  const references = source
    ? [{ type: 'chat', id: source.id, name: chatTitleOf(source) }]
    : input.references ?? []
  const handoff: HandoffOrigin = {
    handoffFromChatId: input.sourceSessionId ?? null,
    handoffFromUserId: input.actingUserId,
    handoffAt: new Date().toISOString(),
  }
  // The origin also rides on the text part, not just on the queue row's body:
  // `dispatchRow` deletes the queue row, and `ChatMessage` has no free column
  // for it, so this is what makes "delivered" durable for the source chip after
  // the turn starts (or fails). Every parts consumer filters on
  // `type === 'text'` and reads `.text`, so the key is inert everywhere else.
  const parts = JSON.stringify([{ type: 'text', text: content, handoff }])

  await (prisma as any).chatQueuedMessage.create({
    data: {
      id: messageId,
      sessionId: target.id,
      userId: input.actingUserId,
      position: await nextPosition(target.id),
      status: 'pending',
      kind: 'user',
      content,
      parts,
      body: JSON.stringify({
        text: content,
        chatSessionId: target.id,
        userId: input.actingUserId,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
        references,
        origin: handoff,
      }),
    },
  })

  // No ChatMessage is written here on purpose: a queued handoff shows only in
  // the target's composer dock (SHO-45, "queued ⇒ dock only"). `dispatchRow`
  // persists this same row id when it takes the queue row, which is the moment
  // the turn actually starts.
  const started = !(target as any).activeTurnId
  if (started) {
    // Fire and forget: dispatchNext streams the target's whole turn, and the
    // person sending a tag must not wait for it. If the target picked up a turn
    // in between, the queue keeps the row and drains it when that turn ends.
    void dispatchNext(target.id).catch((err: any) => {
      console.warn(`[ChatMention] Dispatch failed for ${target.id}:`, err?.message ?? err)
    })
  }

  return {
    id: target.id,
    title: chatTitleOf(target),
    workspaceId: scope.workspaceId,
    workspaceName: scope.workspaceName,
    projectId: scope.projectId,
    started,
    messageId,
  }
}

/**
 * Deliver every chat tagged in a message. Self-tags, chats the sender cannot
 * open, archived chats and unknown ids are dropped (never errors) so a stale
 * picker entry cannot fail the turn.
 */
export async function deliverChatMentions(input: {
  text: string
  actingUserId: string
  sourceSessionId?: string | null
  references?: unknown[]
}): Promise<ChatMentionDeliveryResult> {
  const ids = mentionedChatIds(input.text)
  const delivered: DeliveredChatMention[] = []
  const dropped: string[] = []
  for (const chatId of ids) {
    if (input.sourceSessionId && chatId === input.sourceSessionId) {
      dropped.push(chatId)
      continue
    }
    try {
      const result = await handOffToChat({
        targetChatId: chatId,
        // The target keeps the other tags for context; only its own token is
        // dropped, so it does not render as a chip back to itself.
        text: input.text.replaceAll(chatMentionToken(chatId), '').replace(/[ \t]{2,}/g, ' ').trim(),
        actingUserId: input.actingUserId,
        sourceSessionId: input.sourceSessionId ?? null,
        references: input.references,
      })
      if (result) delivered.push(result)
      else dropped.push(chatId)
    } catch (error: any) {
      console.warn(`[ChatMention] Failed to hand off to ${chatId}:`, error?.message ?? error)
      dropped.push(chatId)
    }
  }
  return { delivered, dropped }
}
