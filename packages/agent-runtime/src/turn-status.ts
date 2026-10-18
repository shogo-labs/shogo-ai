// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Payload of `GET /agent/chat/:chatSessionId/turn` — the read-only turn probe
 * a client uses to decide whether to reconnect, and the one place a finished
 * call's reply can be read after its stream buffer expired.
 */
import type { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'

type TurnRegistry = Pick<StreamBufferStore, 'snapshot' | 'turnReply'>

export interface TurnStatusResponse {
  status: number
  body: Record<string, unknown>
}

/**
 * A turn that is still `active` reports no reply (the final text is not known
 * yet). Once terminal — or once the buffer is gone but the turn's reply was
 * recorded — `reply` carries the text the turn finished with, so a caller that
 * missed the stream can persist it instead of re-running the turn.
 */
export function describeTurn(store: TurnRegistry, chatSessionId: string): TurnStatusResponse {
  const snapshot = store.snapshot(chatSessionId)
  const reply = store.turnReply(chatSessionId)
  if (!snapshot) {
    if (!reply) return { status: 404, body: { status: 'unknown' } }
    return {
      status: 200,
      body: {
        chatSessionId,
        turnId: reply.turnId,
        status: 'completed',
        lastSeq: 0,
        terminal: null,
        createdAt: reply.completedAt,
        completedAt: reply.completedAt,
        lastEventAt: reply.completedAt,
        reply: reply.reply,
      },
    }
  }
  return {
    status: 200,
    body: {
      chatSessionId,
      turnId: snapshot.turnId,
      status: snapshot.status,
      lastSeq: snapshot.lastSeq,
      terminal: snapshot.terminal,
      createdAt: snapshot.createdAt,
      completedAt: snapshot.completedAt,
      lastEventAt: snapshot.lastEventAt,
      reply: snapshot.status === 'active' ? null : (reply?.reply ?? null),
    },
  }
}
