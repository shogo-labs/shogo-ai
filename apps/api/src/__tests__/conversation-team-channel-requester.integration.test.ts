// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A channel an agent creates for someone (`system_apply` teamChannels) has
 * that person in it as its owner, the same as a channel they create
 * themselves. Only workspace members are added, and only on creation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: null }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const upsert = (name: string, body: Record<string, unknown>) =>
  call(null, 'PUT', `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels/${name}`, body)

const membership = (conversationId: string, userId: string) =>
  db.conversationMember.findFirst({ where: { conversationId, memberType: 'user', userId } })

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('channels an agent creates for someone', () => {
  test('the requester is added as owner and recorded as creator', async () => {
    const res = await upsert('launch-room', { onBehalfOfUserId: seed.member })
    expect(res.status).toBe(201)
    const id = res.json.channel.id
    expect((await membership(id, seed.member))?.role).toBe('owner')
    expect((await db.conversation.findUnique({ where: { id } })).createdById).toBe(seed.member)

    const listed = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    expect(JSON.stringify(listed.json)).toContain('launch-room')
  })

  test('a private channel created for someone is visible to them', async () => {
    const res = await upsert('people-ops', { private: true, onBehalfOfUserId: seed.member })
    expect(res.status).toBe(201)
    const open = await call(seed.member, 'GET', `/conversations/${res.json.channel.id}`)
    expect(open.status).toBe(200)
  })

  test('someone outside the workspace is not added', async () => {
    const res = await upsert('outsider-room', { onBehalfOfUserId: seed.outsider })
    expect(res.status).toBe(201)
    expect(await membership(res.json.channel.id, seed.outsider)).toBeNull()
  })

  test('updating an existing channel does not add the requester', async () => {
    const first = await upsert('ops-room', {})
    const again = await upsert('ops-room', { topic: 'Ops', onBehalfOfUserId: seed.member })
    expect(again.status).toBe(200)
    expect(again.json.channel.id).toBe(first.json.channel.id)
    expect(await membership(first.json.channel.id, seed.member)).toBeNull()
  })
})
