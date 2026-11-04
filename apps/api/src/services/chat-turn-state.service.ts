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

/** Where a chat's turn state changes are published, so every open window hears about it. */
export const CHAT_SESSION_TURN_EVENT = 'chat-session.turn'

export type ChatSessionTurnEvent = {
  type: typeof CHAT_SESSION_TURN_EVENT
  chatSessionId: string
  turnId: string
  state: 'started' | 'ended'
}

/**
 * Tell every window showing this chat that its turn started or ended (SHO-299).
 *
 * A chat open in two windows used to be two islands: the panel only looks for a
 * turn on focus (and after its own turn ends), so a window that stayed visible
 * never learned that another window — or another device — was running one.
 * Publishing at the turn-state insert point means every starter (HTTP routes,
 * the channel dispatcher, the queue, a reattach) and every ender gets it for
 * free, the same way `drainAfterTurn` does.
 *
 * The payload carries no message text, and it never fails the turn: a turn that
 * cannot announce itself is still a turn that runs.
 */
export async function publishTurnState(
  chatSessionId: string,
  turnId: string,
  state: ChatSessionTurnEvent['state'],
): Promise<void> {
  try {
    const session = await prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: {
        contextType: true,
        workspaceId: true,
        createdByUserId: true,
        project: { select: { workspaceId: true } },
      },
    })
    if (!session) return
    const workspaceId = session.workspaceId ?? session.project?.workspaceId ?? null
    if (!workspaceId) return
    // Only people who can read the session. A personal workspace chat is its
    // owner's (the rule `assertWorkspaceSessionAccess` applies); a project chat
    // is readable by the project's workspace, which `null` (every member)
    // matches.
    const audience =
      session.contextType === 'workspace' && session.createdByUserId ? [session.createdByUserId] : null
    // Loaded on the first turn rather than with this module: `chat-turn-state`
    // is imported by the desktop host (`server.ts`, `create-local-app.ts`,
    // `local-system.ts`), which needs none of the fanout until a turn actually
    // runs, and `conversation-bus` pulls in the tunnel/Redis layer.
    const { publishConversationEvent } = await import('../lib/conversation-bus')
    publishConversationEvent(workspaceId, { type: CHAT_SESSION_TURN_EVENT, chatSessionId, turnId, state }, audience)
  } catch (error: any) {
    console.warn(`[ChatTurnState] Failed to publish ${state} for chat ${chatSessionId}:`, error?.message ?? error)
  }
}

/**
 * Mark a turn as active. The generated id is returned so completion can
 * conditionally clear only the turn that started this row.
 *
 * `announce` is false for a turn the server replayed on its own (the chat
 * queue, a wake): telling other windows about it would make a window nobody is
 * looking at attach and start the wake watch, which is the polling SHO-53
 * removed. A person's turn is announced (SHO-299).
 */
export async function markTurnStarted(
  chatSessionId: string,
  turnId: string = randomUUID(),
  opts: { announce?: boolean } = {},
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
  if (opts.announce !== false) await publishTurnState(chatSessionId, turnId, 'started')
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
  if (cleared.count === 0) return
  await publishTurnState(chatSessionId, turnId, 'ended')
  drainAfterTurn(chatSessionId)
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
 * Live turn trackers that can write one last snapshot on demand, keyed by chat
 * session (SHO-274).
 *
 * `trackUsageFromStream` writes the assistant row on a 2s throttle, so a clean
 * shutdown used to drop up to two seconds of a reply — and a desktop quit drops
 * the tracker outright. The tracker registers itself here and the shutdown
 * handoff drains it before the process goes away.
 */
const liveSnapshotFlushers = new Map<string, Set<() => Promise<void>>>()

/** Register a tracker's final flush. Returns the unregister function. */
export function registerTurnSnapshotFlusher(chatSessionId: string, flush: () => Promise<void>): () => void {
  const flushers = liveSnapshotFlushers.get(chatSessionId) ?? new Set<() => Promise<void>>()
  flushers.add(flush)
  liveSnapshotFlushers.set(chatSessionId, flushers)
  return () => {
    const current = liveSnapshotFlushers.get(chatSessionId)
    if (!current) return
    current.delete(flush)
    if (current.size === 0) liveSnapshotFlushers.delete(chatSessionId)
  }
}

/**
 * Force one snapshot from every live tracker (or one session's), bounded.
 * Returns how many trackers ran. Failures are logged, never thrown: shutdown
 * must not be held open by a database that is going away with it.
 */
export async function flushLiveSnapshots(
  chatSessionId?: string,
  timeoutMs: number = 2_000,
): Promise<number> {
  const flushers = chatSessionId
    ? [...(liveSnapshotFlushers.get(chatSessionId) ?? [])]
    : [...liveSnapshotFlushers.values()].flatMap((set) => [...set])
  if (flushers.length === 0) return 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(flushers.map((flush) => flush())),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } catch (error) {
    console.warn('[ChatTurnState] Flushing live snapshots failed:', error)
  } finally {
    if (timer) clearTimeout(timer)
  }
  return flushers.length
}

/**
 * On shutdown, hand every turn this process is following to the reattach
 * job: stop heartbeating and age the heartbeat past TURN_REATTACH_AFTER_MS,
 * so the next sweep on another replica claims it.
 * Only the marker is written here. The runtime owns the turn buffer, which
 * doesn't need an API subscriber to survive, and the API pod is killed after
 * its termination grace period, so waiting for a takeover would not finish.
 */
export async function releaseTurnsForHandoff(): Promise<number> {
  // Persist what the trackers hold before anything else: the buffer survives a
  // pod handoff, but a desktop quit or a killed process does not, and the row is
  // the only copy of what the person already read (SHO-274).
  const flushed = await flushLiveSnapshots(undefined, 2_000)
  if (flushed > 0) console.log(`[ChatTurnState] Flushed ${flushed} live turn snapshot(s) before handoff`)
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
 * Clear every turn the previous desktop process was running (SHO-274).
 *
 * The desktop kills every runtime on boot (`local-server.ts
 * killStaleProcessGroup`), so no turn from the previous process can still be
 * alive — but nothing cleared `activeTurnId`, and `isSessionIdle` reads a
 * heartbeat under 10 minutes as live. A crash therefore blocked its own session
 * for ten minutes: the SHO-121 resume and anything the person sent after the
 * restart queued behind a turn that no process was running ("my message
 * vanished").
 *
 * Cloud does not need this: its reattach job clears the turn it cannot follow.
 * The stamping below is the same function that job uses, so both surfaces leave
 * the transcript in the same state.
 */
export async function sweepDeadTurnsOnLocalBoot(): Promise<number> {
  const sessions = await prisma.chatSession.findMany({
    where: { activeTurnId: { not: null } },
    select: { id: true, activeTurnId: true },
  })
  if (sessions.length === 0) return 0
  const { stampTurnInterrupted } = await import('./chat-resume.service')
  // The journal holds every frame that reached the client during that turn, so
  // the row can be rebuilt exactly — before the turn is cleared (SHO-274).
  const { recoverTurnFromJournal } = await import('./chat-turn-recovery')
  let swept = 0
  for (const session of sessions) {
    const turnId = session.activeTurnId
    if (!turnId) continue
    const recovered = await recoverTurnFromJournal(session.id, turnId, { keepFrames: true })
      .then((result) => result.recovered)
      .catch((error) => {
        console.warn(`[ChatTurnState] Journal recovery for ${session.id} failed:`, error?.message ?? error)
        return false
      })
    const cleared = await prisma.chatSession.updateMany({
      where: { id: session.id, activeTurnId: turnId },
      data: CLEARED_TURN,
    })
    if (cleared.count === 0) continue
    swept++
    // A recovered row already says the turn ended; only a turn with no frames
    // at all needs the stamp that stops it reading as unfinished.
    if (!recovered) {
      await stampTurnInterrupted(session.id, { reason: 'runtime_restarted' }).catch((error) =>
        console.warn(`[ChatTurnState] Failed to stamp interrupted row for ${session.id}:`, error),
      )
    }
    // Whatever was waiting behind that turn has no starter left otherwise.
    drainAfterTurn(session.id)
  }
  if (swept > 0) console.log(`[ChatTurnState] Cleared ${swept} turn(s) left running by the previous process`)
  return swept
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
