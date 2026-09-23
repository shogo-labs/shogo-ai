// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

export type ActiveChatTurn = {
  chatSessionId: string
  turnId: string
  sessionName: string
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
  await prisma.chatSession.update({
    where: { id: chatSessionId },
    data: {
      activeTurnId: turnId,
      activeTurnStartedAt: new Date(),
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
    data: {
      activeTurnId: null,
      activeTurnStartedAt: null,
    },
  })
}

/** Explicit stop requests can clear a turn without waiting for stream replay. */
export async function clearActiveTurn(chatSessionId: string): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: chatSessionId },
    data: {
      activeTurnId: null,
      activeTurnStartedAt: null,
    },
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
  const startedAfter = new Date(Date.now() - staleAfterMs)
  const sessions = await prisma.chatSession.findMany({
    where: {
      isArchived: false,
      activeTurnStartedAt: { not: null, gt: startedAfter },
      OR: [
        { workspaceId },
        { project: { workspaceId } },
      ],
    },
    select: {
      id: true,
      name: true,
      inferredName: true,
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
      projectId: session.project?.id ?? null,
      projectName: session.project?.name ?? null,
      projectHidden: session.project?.hidden ?? false,
      startedAt: session.activeTurnStartedAt!,
    }))
}

