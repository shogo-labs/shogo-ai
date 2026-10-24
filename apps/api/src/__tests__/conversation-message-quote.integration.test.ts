// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /conversation-messages/:id` is what a quote is built from, so it has to
 * say where the message came from. It already checks that the reader can see
 * the message; the channel it names is the same one that check passed for, and
 * a message they can't see is a 404 with nothing in it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /conversation-messages/:id', () => {
  test('labels the message with the channel it came from', async () => {
    const created = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'qa70-label' })
    expect(created.status).toBe(201)
    const conversationId = created.json.conversation.id

    const posted = await call(seed.member, 'POST', `/conversations/${conversationId}/messages`, {
      text: 'The migration is ready for review.',
      clientMsgId: crypto.randomUUID(),
    })
    expect(posted.status).toBe(201)

    const res = await call(seed.member, 'GET', `/conversation-messages/${posted.json.message.id}`)
    expect(res.status).toBe(200)
    expect(res.json.message.conversation).toMatchObject({ id: conversationId, name: 'qa70-label', kind: 'public' })
    // The quote needs who and when, and nothing that reads like a leak: no topic.
    expect(res.json.message.conversation.topic).toBeUndefined()
  })

  test('a DM keeps its kind, so the card can say DM instead of a name', async () => {
    const dm = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.owner] })
    // Opening an existing DM is the same success, so it can answer 200.
    expect(dm.status).toBeLessThan(300)
    const conversationId = dm.json.conversation.id

    const posted = await call(seed.member, 'POST', `/conversations/${conversationId}/messages`, {
      text: 'just between us',
      clientMsgId: crypto.randomUUID(),
    })
    expect(posted.status).toBe(201)

    const res = await call(seed.member, 'GET', `/conversation-messages/${posted.json.message.id}`)
    expect(res.status).toBe(200)
    expect(res.json.message.conversation.kind).toBe('dm')
  })

  test('a message someone cannot see is a 404 with no channel in it', async () => {
    const created = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'qa70-secret' })
    const conversationId = created.json.conversation.id
    const posted = await call(seed.member, 'POST', `/conversations/${conversationId}/messages`, {
      text: 'internal only',
      clientMsgId: crypto.randomUUID(),
    })

    const res = await call(seed.outsider, 'GET', `/conversation-messages/${posted.json.message.id}`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.json)).not.toContain('qa70-secret')
  })
})
