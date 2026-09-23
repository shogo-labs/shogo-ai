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
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
export const ACTIVE_TURN_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000

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
 * Clear an active turn only when it is still the turn that started it.
 * This prevents a delayed stream completion from clearing a newer turn.
 */
export async function markTurnEnded(chatSessionId: string, turnId: string): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: chatSessionId, activeTurnId: turnId },
    data: CLEARED_TURN,
  })
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
  return () => clearInterval(timer)
}

/**
 * Explicit stop requests clear whatever turn is active without waiting for
 * stream replay. `scope` must pin the session to the caller's project or
 * workspace so a client-supplied session id can't clear a foreign chat.
 */
export async function clearActiveTurn(
  scope: Prisma.ChatSessionWhereInput & { id: string },
): Promise<void> {
  await prisma.chatSession.updateMany({
    where: scope,
    data: CLEARED_TURN,
  })
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

  return sessions
    .filter((session) => session.activeTurnId && session.activeTurnStartedAt)
    .map((session) => ({
      chatSessionId: session.id,
      turnId: session.activeTurnId!,
      sessionName: session.name || session.inferredName || 'Chat',
      isPrimary: session.isPrimary,
      projectId: session.project?.id ?? null,
      projectName: session.project?.name ?? null,
      projectHidden: session.project?.hidden ?? false,
      startedAt: session.activeTurnStartedAt!,
    }))
}
