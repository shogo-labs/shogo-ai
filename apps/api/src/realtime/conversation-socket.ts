// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Realtime socket for workspace channels. One socket per client per
 * workspace carries every conversation event the user may see. Clients send
 * `typing` and `ping` frames; everything else is server-to-client.
 *
 * On reconnect, clients backfill through REST (`afterSeq`) rather than asking
 * the socket to replay, so a dropped pod never loses messages.
 */

import {
  canReceive,
  publishConversationEvent,
  subscribeWorkspaceEvents,
  type ConversationEnvelope,
} from '../lib/conversation-bus'
import { conversationAudience, loadAccess } from '../services/conversation.service'
import { recordPresence, registerPresenceSocket } from '../services/conversation-presence'

export interface ConversationSocketData {
  kind: 'conversation-rt'
  userId: string
  userName: string
  workspaceId: string
  unsubscribe?: () => void
  readable?: Map<string, { ok: boolean; at: number; audience: string[] | null }>
  lastTyping?: Map<string, number>
  presenceTimer?: ReturnType<typeof setInterval>
}

const ACCESS_CACHE_MS = 60_000
const TYPING_INTERVAL_MS = 2_000
const PRESENCE_INTERVAL_MS = 30_000

export function isConversationSocketData(data: unknown): data is ConversationSocketData {
  return !!data && typeof data === 'object' && (data as any).kind === 'conversation-rt'
}

export function serializeEnvelope(envelope: ConversationEnvelope): string {
  return JSON.stringify(envelope.event)
}

async function cachedAccess(data: ConversationSocketData, conversationId: string) {
  data.readable ??= new Map()
  const hit = data.readable.get(conversationId)
  if (hit && Date.now() - hit.at < ACCESS_CACHE_MS) return hit
  let entry: { ok: boolean; at: number; audience: string[] | null }
  try {
    const access = await loadAccess(conversationId, data.userId)
    entry = {
      ok: access.conversation.workspaceId === data.workspaceId,
      at: Date.now(),
      audience: await conversationAudience(access.conversation),
    }
  } catch {
    entry = { ok: false, at: Date.now(), audience: null }
  }
  data.readable.set(conversationId, entry)
  return entry
}

export const conversationSocketHandlers = {
  open(ws: any) {
    const data = ws.data as ConversationSocketData
    data.unsubscribe = subscribeWorkspaceEvents(data.workspaceId, (envelope) => {
      if (!canReceive(envelope, data.userId)) return
      if (envelope.event.type === 'typing' && envelope.event.userId === data.userId) return
      try {
        ws.send(serializeEnvelope(envelope))
      } catch {
        // Socket closing; the close handler unsubscribes.
      }
    })
    registerPresenceSocket(data.workspaceId, data.userId)
    void recordPresence(data.workspaceId, data.userId, 'active')
    data.presenceTimer = setInterval(() => {
      void recordPresence(data.workspaceId, data.userId, 'active')
    }, PRESENCE_INTERVAL_MS)
    ;(data.presenceTimer as any).unref?.()
    ws.send(JSON.stringify({ type: 'ready', workspaceId: data.workspaceId, userId: data.userId }))
  },

  async message(ws: any, raw: string | Buffer) {
    const data = ws.data as ConversationSocketData
    let frame: any
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      return
    }
    if (frame?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: frame.t ?? Date.now() }))
      return
    }
    if (frame?.type === 'presence') {
      const status = frame.status === 'away' ? 'away' : 'active'
      void recordPresence(data.workspaceId, data.userId, status)
      return
    }
    if (frame?.type === 'typing' && typeof frame.conversationId === 'string') {
      data.lastTyping ??= new Map()
      const key = `${frame.conversationId}:${frame.threadRootId ?? ''}`
      const last = data.lastTyping.get(key) ?? 0
      if (Date.now() - last < TYPING_INTERVAL_MS) return
      data.lastTyping.set(key, Date.now())
      const access = await cachedAccess(data, frame.conversationId)
      if (!access.ok) return
      publishConversationEvent(data.workspaceId, {
        type: 'typing',
        conversationId: frame.conversationId,
        threadRootId: typeof frame.threadRootId === 'string' ? frame.threadRootId : null,
        userId: data.userId,
        name: data.userName,
      }, access.audience)
    }
  },

  close(ws: any) {
    const data = ws.data as ConversationSocketData
    data.unsubscribe?.()
    data.unsubscribe = undefined
    if (data.presenceTimer) clearInterval(data.presenceTimer)
    void recordPresence(data.workspaceId, data.userId, 'offline')
  },
}
