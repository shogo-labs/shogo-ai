// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getRuntimeManager } from '../lib/runtime'
import { verifySessionAccess, type HookContext } from '../generated/chat-queued-message.hooks'
import { dispatchNext } from '../services/chat-queue-dispatcher.service'
import { projectChatRoutes } from './project-chat'
import { workspaceChatRoutes } from './workspace-chat'

function hookContext(c: any, body: unknown = {}): HookContext {
  const auth = c.get('auth')
  return {
    body,
    params: c.req.param() || {},
    query: Object.fromEntries(new URL(c.req.url).searchParams),
    userId: auth?.userId,
    tunnelAuthenticated: !!auth?.tunnelAuthenticated,
    auth,
    prisma,
  }
}

function hookError(c: any, result: any): Response {
  const code = result.error?.code
  const status =
    code === 'unauthorized' ? 401 :
    code === 'forbidden' ? 403 :
    code === 'not_found' ? 404 :
    code === 'busy' ? 409 : 400
  return c.json({ error: result.error }, status)
}

function parseJsonBody(value: string | null | undefined): Record<string, any> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {}
  } catch {
    return {}
  }
}

function taskNotificationOf(value: string | null | undefined): Record<string, any> {
  const tn = parseJsonBody(value).taskNotification
  return tn && typeof tn === 'object' ? (tn as Record<string, any>) : {}
}

/**
 * How long after a "send now" the promoted row is asked for again.
 *
 * The stop clears the session's turn on a hop of its own, so the dispatch that
 * follows the click can still find the session busy and leave the row promoted
 * but unclaimed. The turn it would be waiting for is the one the click just
 * stopped, so nothing else is coming to move the queue along — without this,
 * "send now" stops the reply and then sends nothing (SHO-198).
 */
const SEND_NOW_DISPATCH_RETRY_MS = 2_000

/** Both actions reorder or dispatch the queue, so they need write access to the session. */
async function getAuthorizedRow(c: any, id: string): Promise<any | Response> {
  const queued = await (prisma as any).chatQueuedMessage.findUnique({ where: { id }, select: { sessionId: true } })
  if (!queued) return c.json({ error: { code: 'not_found', message: 'Queued message not found' } }, 404)
  const result = await verifySessionAccess(queued.sessionId, hookContext(c), `${c.req.method} ${c.req.path}`)
  if (!result.ok) return hookError(c, result)
  const row = await (prisma as any).chatQueuedMessage.findUnique({
    where: { id },
    include: {
      session: {
        select: {
          contextType: true,
          contextId: true,
          workspaceId: true,
          activeTurnId: true,
        },
      },
    },
  })
  if (!row) return c.json({ error: { code: 'not_found', message: 'Queued message not found' } }, 404)
  return row
}

async function stopActiveTurn(row: any, userId: string): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    'X-Chat-Session-Id': row.sessionId,
    'X-Queue-User-Id': userId,
    'X-Billing-User-Id': userId,
  }
  let response: Response
  if (row.session.contextType === 'project' && row.session.contextId) {
    response = await projectChatRoutes({
      runtimeManager: getRuntimeManager(),
    }).fetch(
      new Request(`http://internal/projects/${encodeURIComponent(row.session.contextId)}/chat/stop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chatSessionId: row.sessionId }),
      }),
    )
  } else if (row.session.workspaceId) {
    response = await workspaceChatRoutes({
      runtimeManager: getRuntimeManager(),
      alwaysEnabled: true,
      resolveUserId: async (c) =>
        c.req.header('X-Queue-User-Id') || c.req.header('X-Billing-User-Id') || null,
    }).fetch(
      new Request(`http://internal/workspaces/${encodeURIComponent(row.session.workspaceId)}/chat/stop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chatSessionId: row.sessionId }),
      }),
    )
  } else {
    throw new Error('Chat session has no dispatchable project or workspace')
  }
  if (!response.ok) {
    throw new Error(`Unable to stop active turn (${response.status})`)
  }
}

export function chatQueuedMessageActionsRoutes(): Hono {
  const router = new Hono()

  router.post('/:id/reorder', async (c) => {
    const id = c.req.param('id')
    const row = await getAuthorizedRow(c, id)
    if (row instanceof Response) return row
    if (row.status === 'dispatching') {
      return c.json({ error: { code: 'busy', message: 'Queued message is already being dispatched' } }, 409)
    }
    const body = await c.req.json().catch(() => ({}))
    if (body.direction !== 'up' && body.direction !== 'down') {
      return c.json({ error: { code: 'bad_request', message: 'direction must be up or down' } }, 400)
    }

    const neighbor = await (prisma as any).chatQueuedMessage.findFirst({
      where: {
        sessionId: row.sessionId,
        status: { in: ['pending', 'failed'] },
        ...(body.direction === 'up'
          ? { position: { lt: row.position } }
          : { position: { gt: row.position } }),
      },
      orderBy: [{ position: body.direction === 'up' ? 'desc' : 'asc' }, { createdAt: 'asc' }],
    })
    if (!neighbor) return c.json({ ok: true, data: row })

    await (prisma as any).$transaction([
      (prisma as any).chatQueuedMessage.update({
        where: { id: row.id },
        data: { position: neighbor.position },
      }),
      (prisma as any).chatQueuedMessage.update({
        where: { id: neighbor.id },
        data: { position: row.position },
      }),
    ])
    const updated = await (prisma as any).chatQueuedMessage.findUnique({ where: { id } })
    return c.json({ ok: true, data: updated })
  })

  router.post('/:id/send-now', async (c) => {
    const id = c.req.param('id')
    const row = await getAuthorizedRow(c, id)
    if (row instanceof Response) return row
    if (row.status === 'dispatching') {
      return c.json({ error: { code: 'busy', message: 'Queued message is already being dispatched' } }, 409)
    }
    const auth = c.get('auth')
    const userId = auth?.userId
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const first = await (prisma as any).chatQueuedMessage.findFirst({
      where: { sessionId: row.sessionId, status: { in: ['pending', 'failed'] } },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { position: true },
    })
    await (prisma as any).chatQueuedMessage.update({
      where: { id },
      data: { position: (first?.position ?? row.position) - 1, status: 'pending', error: null },
    })

    try {
      if (row.session.activeTurnId) await stopActiveTurn(row, userId)
    } catch (error) {
      return c.json({
        error: {
          code: 'stop_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }, 502)
    }
    // Ask again shortly if the first dispatch found the session still busy: the
    // stop that clears the turn has a hop of its own, and by then the row is
    // promoted and waiting. The retry runs only while the row is still queued,
    // so a dispatch that did land — or a person who removed it — is left alone.
    void dispatchNext(row.sessionId)
      .then((started) => {
        if (started) return
        const retry = setTimeout(async () => {
          try {
            const still = await (prisma as any).chatQueuedMessage.findUnique({
              where: { id },
              select: { status: true },
            })
            if (still?.status === 'pending') await dispatchNext(row.sessionId)
          } catch (error) {
            console.warn(`[ChatQueue] Dispatch retry for ${id} failed:`, error)
          }
        }, SEND_NOW_DISPATCH_RETRY_MS)
        // Never hold the process open for a retry nobody is waiting on.
        ;(retry as any)?.unref?.()
      })
      .catch((error) => {
        console.warn(`[ChatQueue] Dispatch after send now for ${id} failed:`, error)
      })
    const updated = await (prisma as any).chatQueuedMessage.findUnique({ where: { id } })
    return c.json({ ok: true, data: updated })
  })

  router.post('/:id/resume', async (c) => {
    const id = c.req.param('id')
    const row = await getAuthorizedRow(c, id)
    if (row instanceof Response) return row
    if (row.kind !== 'task_notification') {
      return c.json({ error: { code: 'bad_request', message: 'Only a waiting background update can be resumed' } }, 400)
    }
    if (row.status === 'dispatching') {
      return c.json({ error: { code: 'busy', message: 'Queued message is already being dispatched' } }, 409)
    }
    // Resuming a paused wake is the same thing a person writing does, without
    // writing: the row goes back to pending, and it is marked so the dispatcher
    // does not re-pause it (`wakeRunReset` ends the run of automatic wakes that
    // hit the cap). `consecutiveWakeWaits` reads the mark off the persisted
    // message and starts counting again.
    const body = { ...parseJsonBody(row.body), taskNotification: { ...taskNotificationOf(row.body), paused: false, wakeRunReset: true } }
    const parts = (Array.isArray(parseJsonBody(row.parts) as unknown as any[])
      ? (parseJsonBody(row.parts) as Array<Record<string, any>>)
      : [{ type: 'text', text: row.content }]
    ).map((part) =>
      part?.type === 'data-task-notification'
        ? { ...part, data: { ...(part.data ?? {}), wakeRunReset: true } }
        : part,
    )
    await (prisma as any).chatQueuedMessage.update({
      where: { id },
      data: { status: 'pending', error: null, body: JSON.stringify(body), parts: JSON.stringify(parts) },
    })
    void dispatchNext(row.sessionId)
    const updated = await (prisma as any).chatQueuedMessage.findUnique({ where: { id } })
    return c.json({ ok: true, data: updated })
  })

  return router
}
