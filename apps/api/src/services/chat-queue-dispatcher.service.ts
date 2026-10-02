// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'

const ACTIVE_TURN_STALE_AFTER_MS = 5 * 60 * 1000

/**
 * `chat_queued_messages` replicates between regions, and the claim below is a
 * conditional UPDATE that only serializes writers on one database. Every queue
 * write (claim, user-message persist, turn start, delete, stuck reset) must
 * therefore happen in the session's home region only; otherwise two regions
 * claim the same row and insert the same `chat_messages.id`, which stops
 * logical replication on `insert_exists`. Null in single-region / local mode.
 */
function homeSessionWhere() {
  const home = homeRegionWorkspaceWhere()
  if (!home) return null
  return { OR: [{ project: { workspace: home } }, { workspace: home }] }
}

async function isHomeRegionSession(chatSessionId: string): Promise<boolean> {
  const home = homeSessionWhere()
  if (!home) return true
  const count = await (prisma as any).chatSession.count({
    where: { id: chatSessionId, ...home },
  })
  return count > 0
}

type QueueBody = {
  text?: string
  featureId?: string
  phase?: string
  chatSessionId?: string
  chatSessionName?: string
  workspaceId?: string
  userId?: string
  projectId?: string
  focusedProjectId?: string
  agentMode?: string
  interactionMode?: string
  dualPlan?: boolean
  timezone?: string
  clientTurnId?: string
  viewer?: Record<string, unknown>
  confirmedPlan?: unknown
  ideContext?: unknown
  references?: unknown
  [key: string]: unknown
}

type QueueRow = {
  id: string
  sessionId: string
  userId: string
  content: string
  parts: string | null
  body: string
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

async function consumeResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat runtime returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }

  // The proxy owns stream tracking and persistence, but consuming the returned
  // body prevents a server-side internal fetch from applying backpressure to
  // the runtime stream. The queue row is deleted as soon as the proxy accepts
  // the turn; completion is handled by the proxy's turn-finally hook.
  if (response.body) {
    const reader = response.body.getReader()
    try {
      while (!(await reader.read()).done) {
        // Intentionally discard the server-side SSE copy.
      }
    } finally {
      reader.releaseLock()
    }
  }
}

async function isSessionIdle(chatSessionId: string): Promise<boolean> {
  const session = await (prisma as any).chatSession.findUnique({
    where: { id: chatSessionId },
    select: { activeTurnId: true, activeTurnHeartbeatAt: true },
  })
  if (!session) return false
  if (!session.activeTurnId) return true

  const heartbeat = session.activeTurnHeartbeatAt
    ? new Date(session.activeTurnHeartbeatAt).getTime()
    : 0
  if (heartbeat > Date.now() - ACTIVE_TURN_STALE_AFTER_MS) return false

  // A dead API process can leave the activity marker behind. Clear only the
  // stale marker; a fresh turn is never touched by this recovery path.
  await (prisma as any).chatSession.updateMany({
    where: { id: chatSessionId, activeTurnId: session.activeTurnId },
    data: {
      activeTurnId: null,
      activeTurnStartedAt: null,
      activeTurnHeartbeatAt: null,
    },
  })
  return true
}

async function claimNext(chatSessionId: string): Promise<QueueRow | null> {
  const candidate = await (prisma as any).chatQueuedMessage.findFirst({
    where: { sessionId: chatSessionId, status: 'pending' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })
  if (!candidate) return null

  const claimed = await (prisma as any).chatQueuedMessage.updateMany({
    where: { id: candidate.id, sessionId: chatSessionId, status: 'pending' },
    data: { status: 'dispatching', error: null },
  })
  if (claimed.count !== 1) return null
  return candidate as QueueRow
}

async function persistQueuedUserMessage(row: QueueRow, body: QueueBody): Promise<void> {
  const parts = row.parts || JSON.stringify([{ type: 'text', text: row.content }])
  await (prisma as any).chatMessage.upsert({
    where: { id: row.id },
    create: {
      id: row.id,
      sessionId: row.sessionId,
      role: 'user',
      content: row.content,
      parts,
      agent: 'technical',
      model: typeof body.agentMode === 'string' ? body.agentMode : null,
    },
    update: {},
  })
  await (prisma as any).chatSession.update({
    where: { id: row.sessionId },
    data: { lastActiveAt: new Date(), updatedAt: new Date() },
  })
}

async function dispatchRow(row: QueueRow): Promise<void> {
  const session = await (prisma as any).chatSession.findUnique({
    where: { id: row.sessionId },
    select: {
      id: true,
      contextType: true,
      contextId: true,
      workspaceId: true,
      name: true,
      inferredName: true,
    },
  })
  if (!session) throw new Error('Chat session no longer exists')

  const body = parseJson<QueueBody>(row.body, {})
  const parts = parseJson<Array<Record<string, unknown>>>(row.parts, [
    { type: 'text', text: row.content },
  ])
  const clientTurnId = `queue-${row.id}-${randomUUID()}`
  const requestBody = {
    ...body,
    messages: [{ role: 'user', parts }],
    chatSessionId: row.sessionId,
    userId: row.userId,
    clientTurnId,
    // The queue stores the display text separately from the enriched wire
    // text. If the caller did not store a wire text, the raw prompt is safe.
    text: typeof body.text === 'string' ? body.text : row.content,
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-Chat-Session-Id': row.sessionId,
    'X-Billing-User-Id': row.userId,
    'X-Queue-User-Id': row.userId,
  }
  // Keep the runtime manager out of the module-load graph. This dispatcher is
  // imported by both chat routers, including isolated tests that intentionally
  // mock the runtime boundary. It is only needed when a row is actually
  // dispatched, keeping the runtime graph out of chat-route consumers.
  const { getRuntimeManager } = await import('../lib/runtime')
  const runtimeManager = getRuntimeManager()

  let response: Response
  if (session.contextType === 'project' && session.contextId) {
    const { projectChatRoutes } = await import('../routes/project-chat')
    const router = projectChatRoutes({
      runtimeManager,
      suppressCompletionPush: true,
    })
    response = await router.fetch(
      new Request(`http://internal/projects/${encodeURIComponent(session.contextId)}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }),
    )
  } else if (session.workspaceId) {
    const { workspaceChatRoutes } = await import('../routes/workspace-chat')
    const router = workspaceChatRoutes({
      runtimeManager,
      alwaysEnabled: true,
      resolveUserId: async (c) =>
        c.req.header('X-Queue-User-Id') || c.req.header('X-Billing-User-Id') || null,
    })
    response = await router.fetch(
      new Request(`http://internal/workspaces/${encodeURIComponent(session.workspaceId)}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }),
    )
  } else {
    throw new Error('Chat session has no dispatchable project or workspace')
  }

  // Fail synchronously on a rejected proxy response, then drain its body in
  // the background so the server-side tracker can finish independently of UI.
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat proxy returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  void consumeResponse(response).catch((error) => {
    console.warn(`[ChatQueue] Internal stream consume failed for ${row.id}:`, error)
  })
}

/**
 * Claim and start the oldest pending message for a session.
 *
 * The database claim is deliberately conditional. Multiple API instances may
 * observe the same idle session after a turn completes, but only one can move
 * a row from pending to dispatching. In multi-region mode only the session's
 * home region dispatches; peers return false and the home region's turn-end
 * hook or drain worker picks the replicated row up.
 */
export async function dispatchNext(chatSessionId: string): Promise<boolean> {
  if (!(await isHomeRegionSession(chatSessionId))) return false
  if (!(await isSessionIdle(chatSessionId))) return false
  const row = await claimNext(chatSessionId)
  if (!row) return false

  try {
    const body = parseJson<QueueBody>(row.body, {})
    await persistQueuedUserMessage(row, body)
    await dispatchRow(row)
    await (prisma as any).chatQueuedMessage.delete({ where: { id: row.id } })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await (prisma as any).chatQueuedMessage.updateMany({
      where: { id: row.id, status: 'dispatching' },
      data: { status: 'failed', error: message.slice(0, 4_000) },
    }).catch(() => {})
    console.error(`[ChatQueue] Failed to dispatch ${row.id}:`, error)
    return false
  }
}

export async function resetStuckDispatching(
  olderThan: Date = new Date(Date.now() - 2 * 60 * 1000),
): Promise<number> {
  const home = homeSessionWhere()
  const result = await (prisma as any).chatQueuedMessage.updateMany({
    where: {
      status: 'dispatching',
      updatedAt: { lt: olderThan },
      ...(home ? { session: home } : {}),
    },
    data: { status: 'pending', error: 'Recovered after an interrupted dispatch' },
  })
  return result.count
}

export async function dispatchPendingSessions(): Promise<number> {
  const home = homeSessionWhere()
  const rows = await (prisma as any).chatQueuedMessage.findMany({
    where: { status: 'pending', ...(home ? { session: home } : {}) },
    distinct: ['sessionId'],
    select: { sessionId: true },
  })
  let dispatched = 0
  for (const row of rows) {
    if (await dispatchNext(row.sessionId)) dispatched++
  }
  return dispatched
}
