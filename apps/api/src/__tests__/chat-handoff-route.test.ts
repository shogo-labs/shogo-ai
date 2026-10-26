// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-118, end to end through the real routes on a real database: the two calls
 * from issue #1606 replay clean.
 *
 * ```
 * chat_handoff { chat: "591284d8…" } -> 404 chat_not_found   (before this card)
 * ```
 *
 * The ids in that transcript are the ordinary shapes the product writes — a
 * workspace chat anchored on a project, and an unowned workspace chat — so both
 * must deliver, a title must resolve, and a chat in a workspace the requester
 * does not belong to must still be refused, with the chats they *can* open.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

process.env.BETTER_AUTH_SECRET ||= 'chat-handoff-route-test-secret'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { signRequesterTicket } = await import('../lib/requester-ticket')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route(
  '/api/internal',
  runtimeInternalRoutes({
    authenticate: async (c: any) => {
      const raw = c.req.header('x-identity')
      return raw ? JSON.parse(raw) : null
    },
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
  } as any),
)

const asWorkspaceRuntime = (workspaceId: string) => ({
  'x-identity': JSON.stringify({ kind: 'workspace', workspaceId }),
})

function ticket(workspaceId: string, userId: string) {
  return signRequesterTicket({ projectId: `ws:${workspaceId}`, userId })
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api/internal${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const handoff = (chat: unknown, message = 'stop every lane', workspaceId = seed.workspaceId, userId = seed.owner) =>
  call(
    'POST',
    `/workspaces/${workspaceId}/chat-handoff`,
    { chat, message },
    { ...asWorkspaceRuntime(workspaceId), 'X-Requester-Ticket': ticket(workspaceId, userId) },
  )

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('chat_handoff routes', () => {
  test('a project-anchored, unowned workspace chat delivers', async () => {
    const chat = await db.chatSession.create({
      data: {
        inferredName: 'Anchored chat',
        contextType: 'workspace',
        contextId: seed.projectId,
        createdByUserId: null,
      },
    })
    const res = await handoff(chat.id)
    expect(res.status).toBe(200)
    expect(res.json.delivered.title).toBe('Anchored chat')
    const queued = await db.chatQueuedMessage.findFirst({ where: { sessionId: chat.id } })
    expect(queued.content).toContain('stop every lane')
  })

  test('an unowned workspace chat in the requester’s workspace delivers, by id and by title', async () => {
    const chat = await db.chatSession.create({
      data: { inferredName: 'Workspace chat', name: 'Workspace chat', contextType: 'workspace', workspaceId: seed.workspaceId, createdByUserId: null },
    })
    const byId = await handoff(chat.id)
    expect(byId.status).toBe(200)
    expect(byId.json.delivered.started).toBeBoolean()

    const byTitle = await handoff('Workspace chat')
    expect(byTitle.status).toBe(200)
    expect(byTitle.json.delivered.title).toBe('Workspace chat')
  })

  test('a chat in a workspace the requester is not a member of is refused, with what they can open', async () => {
    const foreign = await db.chatSession.create({
      data: { inferredName: 'Not yours', name: 'Not yours', contextType: 'workspace', workspaceId: seed.otherWorkspaceId, createdByUserId: null },
    })
    const res = await handoff(foreign.id)
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('chat_not_found')
    // The suggestions are titles, and never the refused chat.
    expect(Array.isArray(res.json.error.reachable)).toBe(true)
    expect(res.json.error.reachable).not.toContain('Not yours')
    expect(res.json.error.reachable).toContain('Workspace chat')
  })

  test('chat-reachable answers per id for the acting person', async () => {
    const mine = await db.chatSession.create({
      data: { inferredName: 'Mine', name: 'Mine', contextType: 'workspace', workspaceId: seed.workspaceId, createdByUserId: null },
    })
    const foreign = await db.chatSession.create({
      data: { inferredName: 'Theirs', name: 'Theirs', contextType: 'workspace', workspaceId: seed.otherWorkspaceId, createdByUserId: null },
    })
    const res = await call(
      'GET',
      `/workspaces/${seed.workspaceId}/chat-reachable?ids=${mine.id},${foreign.id},does-not-exist`,
      undefined,
      { ...asWorkspaceRuntime(seed.workspaceId), 'X-Requester-Ticket': ticket(seed.workspaceId, seed.owner) },
    )
    expect(res.status).toBe(200)
    expect(res.json.reachable).toEqual([mine.id])
  })
})
