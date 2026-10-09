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
    void dispatchNext(row.sessionId)
    const updated = await (prisma as any).chatQueuedMessage.findUnique({ where: { id } })
    return c.json({ ok: true, data: updated })
  })

  return router
}
