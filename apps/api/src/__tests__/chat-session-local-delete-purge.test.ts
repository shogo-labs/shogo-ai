// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The local/desktop route set wipes a deleted chat's transcript (SHO-137).
//
// This goes through `createLocalGeneratedRoutes()` and a real `DELETE`, not
// through the hooks: the bug QA caught was that `local-routes.ts` mounted
// `createChatSessionRoutes()` without ever calling `setChatSessionHooks`, so the
// purge never ran on the desktop track even though the hooks were correct. A
// direct-hook test bypasses exactly the wiring that was missing.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const realPurge = { ...(await import('../services/chat-session-history-purge.service')) }
const realAttachments = { ...(await import('../lib/chat-attachments')) }

const purged: any[] = []

mock.module('../services/chat-session-history-purge.service', () => ({
  purgeChatSessionHistory: async (scope: any) => {
    purged.push(scope)
    return { purged: true }
  },
}))
mock.module('../lib/chat-attachments', () => ({
  deleteChatAttachmentPrefix: async () => {},
}))

const { createLocalGeneratedRoutes } = await import('../generated/local-routes')

let SESSIONS: Record<string, any> = {}

function seedSessions() {
  SESSIONS = {
    'chat-project': { contextType: 'project', contextId: 'proj-1', workspaceId: 'ws-1', createdByUserId: 'user-1' },
    'chat-workspace': { contextType: 'workspace', contextId: null, workspaceId: 'ws-1', createdByUserId: 'user-1' },
  }
}
seedSessions()

function makePrisma() {
  return {
    chatSession: {
      findUnique: async ({ where }: any) => SESSIONS[where.id] ?? null,
      delete: async ({ where }: any) => {
        const row = SESSIONS[where.id]
        // Prisma throws P2025 for a missing row; mimic it so the route's own
        // error path is what the delete test exercises, not a lenient mock.
        if (!row) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' })
        delete SESSIONS[where.id]
        return row
      },
    },
  }
}

function makeLocalApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user-1' })
    await next()
  })
  // The real local route set — including whatever hooks it does or does not
  // install for chat sessions.
  app.route('/api', createLocalGeneratedRoutes(makePrisma()))
  return app
}

afterAll(() => {
  mock.module('../services/chat-session-history-purge.service', () => realPurge)
  mock.module('../lib/chat-attachments', () => realAttachments)
})

beforeEach(() => {
  purged.length = 0
  seedSessions()
})

describe('DELETE /api/chat-sessions/:id on the local route set', () => {
  test('a project chat is wiped on its project runtime', async () => {
    const response = await makeLocalApp().request('/api/chat-sessions/chat-project', { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(purged).toEqual([
      { id: 'chat-project', contextType: 'project', contextId: 'proj-1', workspaceId: 'ws-1' },
    ])
  })

  test('a workspace chat is wiped through its workspace', async () => {
    const response = await makeLocalApp().request('/api/chat-sessions/chat-workspace', { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(purged).toHaveLength(1)
    expect(purged[0]).toMatchObject({ id: 'chat-workspace', workspaceId: 'ws-1' })
  })

  test('deleting an unknown chat wipes nothing and still answers like before', async () => {
    const response = await makeLocalApp().request('/api/chat-sessions/nope', { method: 'DELETE' })

    // The route's own error path (prisma throws on a missing row), unchanged by
    // this hook — the point is only that no purge is invented for it.
    expect(response.status).toBe(500)
    expect(purged).toEqual([])
  })
})
