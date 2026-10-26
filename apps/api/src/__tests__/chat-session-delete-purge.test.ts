// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Deleting a chat wipes its durable transcript (SHO-137).
//
// The runtime's `sessions.db` is the S3-synced copy of every conversation. The
// idle TTL used to reclaim it; now that idle time deletes nothing, the only
// thing that may remove that copy is a real delete — so the ChatSession delete
// hooks have to reach the runtime. `purgeChatSessionHistory` existing is not
// enough: these tests fail if nothing calls it.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const realPurge = { ...(await import('../services/chat-session-history-purge.service')) }
const realAttachments = { ...(await import('../lib/chat-attachments')) }
const realAuthzHooks = { ...(await import('../lib/authz/hooks')) }
const realAuthz = { ...(await import('../lib/authz')) }

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
mock.module('../lib/authz/hooks', () => ({
  hookAuthorize: async () => null,
  hookRequire: async () => null,
  hookPrincipal: () => ({ via: 'session', userId: 'user-1' }),
}))
mock.module('../lib/authz', () => ({
  accessibleProjectsWhere: async () => ({}),
}))

const { chatSessionHooks } = await import('../generated/chat-session.hooks')

let SESSIONS: Record<string, any> = {}

/** Each test starts from the same three chats; a delete removes its row. */
function seedSessions() {
  SESSIONS = {
    'chat-project': { contextType: 'project', contextId: 'proj-1', workspaceId: 'ws-1', createdByUserId: 'user-1' },
    'chat-workspace': { contextType: 'workspace', contextId: null, workspaceId: 'ws-1', createdByUserId: 'user-1' },
    'chat-someone-else': { contextType: 'project', contextId: 'proj-1', workspaceId: 'ws-1', createdByUserId: 'user-2' },
  }
}
seedSessions()

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    userId: 'user-1',
    prisma: {
      chatSession: {
        findUnique: async ({ where }: any) => SESSIONS[where.id] ?? null,
      },
    },
    ...overrides,
  } as any
}

/** The route's delete: beforeDelete, the row delete, then afterDelete. */
async function deleteChat(id: string, ctx = makeCtx()) {
  const before = await chatSessionHooks.beforeDelete!(id, ctx)
  if (before && !before.ok) return before
  delete SESSIONS[id]
  await chatSessionHooks.afterDelete!(id, ctx)
  return before
}

afterAll(() => {
  mock.module('../services/chat-session-history-purge.service', () => realPurge)
  mock.module('../lib/chat-attachments', () => realAttachments)
  mock.module('../lib/authz/hooks', () => realAuthzHooks)
  mock.module('../lib/authz', () => realAuthz)
})

beforeEach(() => {
  purged.length = 0
  seedSessions()
})

describe('deleting a chat wipes the runtime copy', () => {
  test('a project chat hands the runtime the project it was deleted from', async () => {
    await deleteChat('chat-project')
    expect(purged).toEqual([
      { id: 'chat-project', contextType: 'project', contextId: 'proj-1', workspaceId: 'ws-1' },
    ])
  })

  test('a workspace chat is wiped through its workspace', async () => {
    await deleteChat('chat-workspace')
    expect(purged).toHaveLength(1)
    expect(purged[0]).toMatchObject({ id: 'chat-workspace', workspaceId: 'ws-1', contextType: 'workspace' })
  })

  test('a tunnel-authenticated delete wipes too (the authz-free branch is not exempt)', async () => {
    await deleteChat('chat-project', makeCtx({ tunnelAuthenticated: true }))
    expect(purged).toHaveLength(1)
    expect(purged[0]).toMatchObject({ id: 'chat-project', contextId: 'proj-1' })
  })
})

describe('a delete that does not happen wipes nothing', () => {
  test("someone else's chat is refused and keeps its history", async () => {
    const result = await deleteChat('chat-someone-else')
    expect(result && result.ok).toBe(false)
    expect(purged).toEqual([])
  })

  test('an anonymous delete is refused before anything is captured', async () => {
    const result = await deleteChat('chat-project', makeCtx({ userId: undefined }))
    expect(result && result.ok).toBe(false)
    expect(purged).toEqual([])
  })
})
