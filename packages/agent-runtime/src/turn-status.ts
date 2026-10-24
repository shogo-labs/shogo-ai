// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Payload of `GET /agent/chat/:chatSessionId/turn` — the read-only turn probe
 * a client uses to decide whether to reconnect, and the one place a finished
 * call's reply can be read after its stream buffer expired.
 */
import type { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
import type { LiveCallState, LiveTurnQueue } from './live-turn-wait'

type TurnRegistry = Pick<StreamBufferStore, 'snapshot' | 'turnReply'>
type Snapshot = NonNullable<ReturnType<TurnRegistry['snapshot']>>
type TurnReply = NonNullable<ReturnType<TurnRegistry['turnReply']>>

export interface TurnStatusResponse {
  status: number
  body: Record<string, unknown>
}

/** The named call the probe is asked about, and what the gate knows of it. */
export interface CallTurnQuery {
  callId: string
  state: LiveCallState | null
}

/**
 * A turn that is still `active` reports no reply (the final text is not known
 * yet). Once terminal — or once the buffer is gone but the turn's reply was
 * recorded — `reply` carries the text the turn finished with, so a caller that
 * missed the stream can persist it instead of re-running the turn.
 *
 * A call waiting behind this chat's live turn is reported **by name** as
 * `status: 'queued'`. That answer cannot be derived from the chat's own state:
 * a busy chat always has an `active` snapshot, and any waiter on the gate may
 * be another window's message rather than this call, so the caller names its
 * call and gets that call's answer. `lost` is the opposite — the gate has no
 * record of the name (the runtime restarted, or the queued item vanished) or
 * the chat was stopped before the call started — and is what tells a follower
 * to fail the call instead of waiting for a turn that will never come.
 */
export function describeTurn(
  store: TurnRegistry,
  chatSessionId: string,
  queued: LiveTurnQueue | null = null,
  call: CallTurnQuery | null = null,
): TurnStatusResponse {
  if (call) return describeCallTurn(store, chatSessionId, call, queued)
  const snapshot = store.snapshot(chatSessionId)
  const reply = store.turnReply(chatSessionId)
  if (!snapshot) {
    if (queued) {
      return {
        status: 200,
        body: {
          chatSessionId,
          status: 'queued',
          queuedSince: queued.since,
          queuedDepth: queued.depth,
          reply: null,
        },
      }
    }
    if (!reply) return { status: 404, body: { status: 'unknown' } }
    return completedBody(chatSessionId, reply)
  }
  return snapshotBody(chatSessionId, snapshot, reply, queued ? { queuedSince: queued.since, queuedDepth: queued.depth } : undefined)
}

function describeCallTurn(
  store: TurnRegistry,
  chatSessionId: string,
  call: CallTurnQuery,
  queued: LiveTurnQueue | null,
): TurnStatusResponse {
  const { callId, state } = call
  if (!state) return lost(chatSessionId, callId)
  // Queued wins over the chat's own turn: the chat being busy is exactly the
  // state this call is waiting on, and its `createdAt` is that other turn's.
  if (typeof state.queuedSince === 'number') {
    return {
      status: 200,
      body: {
        chatSessionId,
        callId,
        status: 'queued',
        queuedSince: state.queuedSince,
        queuedDepth: queued?.depth ?? 1,
        reply: null,
      },
    }
  }
  if (state.stopped) return lost(chatSessionId, callId, 'stopped')
  if (!state.turnId) return lost(chatSessionId, callId)

  const snapshot = store.snapshot(chatSessionId)
  if (snapshot?.turnId === state.turnId) {
    const reply = store.turnReply(chatSessionId)
    return snapshotBody(chatSessionId, snapshot, reply?.turnId === state.turnId ? reply : null, { callId })
  }
  const reply = store.turnReply(chatSessionId)
  if (reply?.turnId === state.turnId) return completedBody(chatSessionId, reply, { callId })
  // Our turn started but its buffer is already gone and its reply was never
  // recorded. Name the turn so the follower attaches to a turn it can identify,
  // and let it report the loss rather than mistake a later turn for ours.
  return {
    status: 200,
    body: {
      chatSessionId,
      callId,
      turnId: state.turnId,
      status: 'started',
      terminal: null,
      createdAt: state.startedAt,
      reply: null,
    },
  }
}

function lost(chatSessionId: string, callId: string, reason?: 'stopped'): TurnStatusResponse {
  return {
    status: 200,
    body: { chatSessionId, callId, status: 'lost', ...(reason ? { reason } : {}), reply: null },
  }
}

function snapshotBody(
  chatSessionId: string,
  snapshot: Snapshot,
  reply: TurnReply | null,
  extra?: Record<string, unknown>,
): TurnStatusResponse {
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
      ...extra,
    },
  }
}

function completedBody(chatSessionId: string, reply: TurnReply, extra?: Record<string, unknown>): TurnStatusResponse {
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
      ...extra,
    },
  }
}
