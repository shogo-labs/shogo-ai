// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { randomUUID } from 'node:crypto'
import type { Prisma } from '../generated/prisma-pg/client'
import { prisma } from '../lib/prisma'

/**
 * A turn whose heartbeat is older than this is treated as dead (API process
 * crashed or restarted mid-stream, so nothing ever ran markTurnEnded).
 * Must stay comfortably above ACTIVE_TURN_HEARTBEAT_INTERVAL_MS.
 */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
export const ACTIVE_TURN_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000
/**
 * The turn reattach job takes over a turn whose heartbeat is older than this.
 * Above the heartbeat interval, below DEFAULT_STALE_AFTER_MS.
 */
export const TURN_REATTACH_AFTER_MS = 3 * 60 * 1000

const CLEARED_TURN = {
  activeTurnId: null,
  activeTurnStartedAt: null,
  activeTurnHeartbeatAt: null,
} as const

export type ActiveChatTurn = {
  chatSessionId: string
  turnId: string
  sessionName: string
  isPrimary: boolean
  projectId: string | null
  projectName: string | null
  projectHidden: boolean
  startedAt: Date
  /** Present when the turn is an agent reply posted into team chat. */
  conversationId?: string
  threadRootId?: string | null
  messageId?: string
  conversationName?: string | null
  conversationKind?: string | null
}

/**
 * Mark a turn as active. The generated id is returned so completion can
 * conditionally clear only the turn that started this row.
 */
export async function markTurnStarted(
  chatSessionId: string,
  turnId: string = randomUUID(),
): Promise<string> {
  const now = new Date()
  await prisma.chatSession.update({
    where: { id: chatSessionId },
    data: {
      activeTurnId: turnId,
      activeTurnStartedAt: now,
      activeTurnHeartbeatAt: now,
    },
  })
  return turnId
}

/**
 * Hand a session on once its turn is gone: its own chat queue first (a person's
 * message, or the row they pressed Send now on), then whatever else is waiting
 * on the same session.
 *
 * This belongs here, at the turn state, because *every* ender has to do it —
 * the HTTP chat routes, a channel run's `endTurn`, the stop routes, the
 * stale-turn recovery — and any one of them that forgot left a pending row with
 * no starter. That is how "Send now" stopped a reply and then sent nothing: the
 * turn was cleared, the row was promoted, and the only thing left to start it
 * was a timer (SHO-198) that guessed at the race (SHO-205).
 */
export function drainAfterTurn(chatSessionId: string): void {
  void import('./conversation-agent-dispatcher')
    .then(({ drainSessionAfterTurn }) => drainSessionAfterTurn(chatSessionId))
    .catch((error) => console.warn(`[ChatTurnState] Failed to hand chat ${chatSessionId} on:`, error))
}

/**
 * Clear an active turn only when it is still the turn that started it.
 * This prevents a delayed stream completion from clearing a newer turn.
 */
export async function markTurnEnded(chatSessionId: string, turnId: string): Promise<void> {
  const cleared = await prisma.chatSession.updateMany({
    where: { id: chatSessionId, activeTurnId: turnId },
    data: CLEARED_TURN,
  })
  // A duplicate or stale completion cleared nothing, so there is no turn for the
  // queue to follow: draining there would start a second turn beside a live one.
  if (cleared.count > 0) drainAfterTurn(chatSessionId)
}

/**
 * End the turn a caller was tracking and hand the session on either way.
 *
 * A turn id that was never marked leaves nothing to clear, so the queue is
 * drained directly rather than waiting for a turn-end that cannot come.
 */
export async function endTurnAndDrain(
  chatSessionId: string,
  turnId: string | null | undefined,
): Promise<void> {
  if (!turnId) return drainAfterTurn(chatSessionId)
  await markTurnEnded(chatSessionId, turnId)
}

/** Refresh liveness for a turn that is still streaming. No-op once it ended or was replaced. */
export async function heartbeatTurn(chatSessionId: string, turnId: string): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: chatSessionId, activeTurnId: turnId },
    data: { activeTurnHeartbeatAt: new Date() },
  })
}

/**
 * Heartbeat a turn on an interval until the returned stop function runs.
 * Callers stop it from the stream-tracking completion path, which outlives
 * the client connection (so a closed tab doesn't make a live turn go stale).
 */
export function startTurnHeartbeat(
  chatSessionId: string,
  turnId: string,
  intervalMs: number = ACTIVE_TURN_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    heartbeatTurn(chatSessionId, turnId).catch((error) =>
      console.warn(`[ChatTurnState] Failed to heartbeat active chat ${chatSessionId}:`, error),
    )
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  const entry = { chatSessionId, turnId, timer }
  heartbeatingTurns.add(entry)
  return () => {
    clearInterval(timer)
    heartbeatingTurns.delete(entry)
  }
}

const heartbeatingTurns = new Set<{ chatSessionId: string; turnId: string; timer: ReturnType<typeof setInterval> }>()

/**
 * On shutdown, hand every turn this process is following to the reattach
 * job: stop heartbeating and age the heartbeat past TURN_REATTACH_AFTER_MS,
 * so the next sweep on another replica claims it.
 * Only the marker is written here. The runtime owns the turn buffer, which
 * doesn't need an API subscriber to survive, and the API pod is killed after
 * its termination grace period, so waiting for a takeover would not finish.
 */
export async function releaseTurnsForHandoff(): Promise<number> {
  const turns = [...heartbeatingTurns]
  heartbeatingTurns.clear()
  if (turns.length === 0) return 0
  const aged = new Date(Date.now() - TURN_REATTACH_AFTER_MS - 1_000)
  await Promise.all(
    turns.map(async ({ chatSessionId, turnId, timer }) => {
      clearInterval(timer)
      await prisma.chatSession
        .updateMany({ where: { id: chatSessionId, activeTurnId: turnId }, data: { activeTurnHeartbeatAt: aged } })
        .catch((error) => console.warn(`[ChatTurnState] Failed to hand off chat ${chatSessionId}:`, error))
    }),
  )
  return turns.length
}

/**
 * Explicit stop requests clear whatever turn is active without waiting for
 * stream replay. `scope` must pin the session to the caller's project or
 * workspace so a client-supplied session id can't clear a foreign chat.
 *
 * `handOff: 'caller'` says the caller dispatches the queue itself, right after
 * this returns and with the outcome in hand — the send-now route does, because
 * it has a person waiting on the answer. Everyone else leaves it to the queue:
 * a stop that clears a turn with a row still pending must not leave that row
 * without a starter.
 */
export async function clearActiveTurn(
  scope: Prisma.ChatSessionWhereInput & { id: string },
  opts: { handOff?: 'queue' | 'caller' } = {},
): Promise<void> {
  const cleared = await prisma.chatSession.updateMany({
    where: scope,
    data: CLEARED_TURN,
  })
  if (cleared.count > 0 && opts.handOff !== 'caller') drainAfterTurn(scope.id)
}

/**
 * Return fresh active turns for a workspace. Project-scoped sessions derive
 * their workspace through the project relation; workspace-scoped sessions
 * use ChatSession.workspaceId directly.
 */
export async function listActiveChatTurns(
  workspaceId: string,
  opts: { staleAfterMs?: number } = {},
): Promise<ActiveChatTurn[]> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const heartbeatAfter = new Date(Date.now() - staleAfterMs)
  const sessions = await prisma.chatSession.findMany({
    where: {
      isArchived: false,
      activeTurnHeartbeatAt: { gt: heartbeatAfter },
      OR: [
        { workspaceId },
        { project: { workspaceId } },
      ],
    },
    select: {
      id: true,
      name: true,
      inferredName: true,
      isPrimary: true,
      activeTurnId: true,
      activeTurnStartedAt: true,
      project: {
        select: {
          id: true,
          name: true,
          hidden: true,
        },
      },
    },
    orderBy: { activeTurnStartedAt: 'desc' },
  })

  const live = sessions.filter((session) => session.activeTurnId && session.activeTurnStartedAt)
  const replies = await conversationReplies(live.map((session) => session.id))

  return live.map((session) => {
    const reply = replies.get(session.id)
    return {
      chatSessionId: session.id,
      turnId: session.activeTurnId!,
      sessionName: session.name || session.inferredName || 'Chat',
      isPrimary: session.isPrimary,
      projectId: session.project?.id ?? null,
      projectName: session.project?.name ?? null,
      projectHidden: session.project?.hidden ?? false,
      startedAt: session.activeTurnStartedAt!,
      ...(reply
        ? {
            conversationId: reply.conversationId,
            threadRootId: reply.threadRootId,
            messageId: reply.id,
            conversationName: reply.conversation.name || reply.conversation.slug,
            conversationKind: reply.conversation.kind,
          }
        : {}),
    }
  })
}

/**
 * Newest agent reply per session, so a live turn can point at its channel and thread.
 * `seq` is only ordered within one conversation, so recency comes from `createdAt`.
 */
async function conversationReplies(sessionIds: string[]) {
  const rows = await Promise.all(
    sessionIds.map((agentSessionId) =>
      prisma.conversationMessage.findFirst({
        where: { agentSessionId, authorType: 'agent', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          conversationId: true,
          threadRootId: true,
          conversation: { select: { name: true, slug: true, kind: true } },
        },
      }),
    ),
  )
  const bySession = new Map<string, NonNullable<(typeof rows)[number]>>()
  rows.forEach((row, index) => {
    if (row) bySession.set(sessionIds[index], row)
  })
  return bySession
}
