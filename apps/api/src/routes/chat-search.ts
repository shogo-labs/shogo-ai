// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { searchWorkspaceChats } from '../services/chat-search.service'

export function chatSearchRoutes() {
  const router = new Hono()

  router.get('/chat-search', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string; tunnelAuthenticated?: boolean } | undefined
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const workspaceId = c.req.query('workspaceId')
    const query = c.req.query('q') ?? ''
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0))

    if (!workspaceId) {
      return c.json({ error: { code: 'bad_request', message: 'workspaceId is required' } }, 400)
    }

    if (!auth.tunnelAuthenticated) {
      const member = await prisma.member.findFirst({ where: { userId: auth.userId, workspaceId } })
      if (!member) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }
    }

    const result = await searchWorkspaceChats({ prisma, workspaceId, query, limit, offset })
    return c.json({ ok: true, ...result })
  })

  return router
}