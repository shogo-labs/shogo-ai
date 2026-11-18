// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Messages from <member>" (SHO-419) through the real route and a real SQLite
 * database: `GET /conversations/:id/messages?from=` returns one member's
 * messages — top-level posts and thread replies — newest first, for people and
 * for both kinds of agent, and refuses the shapes it cannot serve.
 *
 * Run: bun test apps/api/src/__tests__/conversation-member-messages.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const service = await import('../services/conversation.service')

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

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A fresh public channel with a known cast: two people, one project agent, the workspace agent. */
async function channelWithCast() {
  const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: `cast-${crypto.randomUUID().slice(0, 6)}` })
  const conversationId = created.json.conversation.id
  const post = (text: string, extra: Record<string, unknown> = {}) =>
    service.postMessage({ conversationId, text, ...extra } as any)
  const ada = await post('ada one', { authorType: 'user', authorUserId: seed.owner })
  const grace = await post('grace one', { authorType: 'user', authorUserId: seed.member })
  const alpha = await post('alpha one', { authorType: 'agent', authorAgentRef: { projectId: seed.projectId, name: 'Alpha' } })
  const ws = await post('workspace agent one', { authorType: 'agent', authorAgentRef: { projectId: null, name: 'Shogo' } })
  const adaReply = await post('ada in thread', {
    authorType: 'user',
    authorUserId: seed.owner,
    threadRootId: grace.row.id,
  })
  const alphaReply = await post('alpha in thread', {
    authorType: 'agent',
    authorAgentRef: { projectId: seed.projectId, name: 'Alpha' },
    threadRootId: grace.row.id,
  })
  return { conversationId, ada, grace, alpha, ws, adaReply, alphaReply }
}

describe('GET /conversations/:id/messages?from=', () => {
  test('a person: their top-level posts and thread replies, newest first', async () => {
    const { conversationId, ada, adaReply } = await channelWithCast()
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=user:${seed.owner}`)
    expect(res.status).toBe(200)
    expect(res.json.messages.map((m: any) => m.id)).toEqual([adaReply.row.id, ada.row.id])
    expect(res.json.hasMore).toBe(false)
  })

  test('a reply carries the thread it belongs to, so the pane can label it', async () => {
    const { conversationId, grace, adaReply } = await channelWithCast()
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=user:${seed.owner}`)
    const reply = res.json.messages.find((m: any) => m.id === adaReply.row.id)
    expect(reply.threadRootId).toBe(grace.row.id)
  })

  test('a project agent, replies included', async () => {
    const { conversationId, alpha, alphaReply } = await channelWithCast()
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=agent:${seed.projectId}`)
    expect(res.status).toBe(200)
    expect(res.json.messages.map((m: any) => m.id)).toEqual([alphaReply.row.id, alpha.row.id])
  })

  test('the workspace agent is agent:ws', async () => {
    const { conversationId, ws } = await channelWithCast()
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=agent:ws`)
    expect(res.status).toBe(200)
    expect(res.json.messages.map((m: any) => m.id)).toEqual([ws.row.id])
  })

  test('pages are full and hasMore is right when other authors are interleaved', async () => {
    const { conversationId, ada, adaReply } = await channelWithCast()
    const first = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=user:${seed.owner}&limit=1`)
    expect(first.json.messages.map((m: any) => m.id)).toEqual([adaReply.row.id])
    expect(first.json.hasMore).toBe(true)
    const second = await call(
      seed.owner,
      'GET',
      `/conversations/${conversationId}/messages?from=user:${seed.owner}&limit=1&beforeSeq=${adaReply.row.seq}`,
    )
    expect(second.json.messages.map((m: any) => m.id)).toEqual([ada.row.id])
    expect(second.json.hasMore).toBe(false)
  })

  test('a deleted message drops out of the list', async () => {
    const { conversationId, ada } = await channelWithCast()
    await service.deleteMessage(ada.row.id, seed.owner)
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=user:${seed.owner}`)
    expect(res.json.messages.map((m: any) => m.id)).not.toContain(ada.row.id)
  })

  test('someone outside the channel cannot read it', async () => {
    const { conversationId } = await channelWithCast()
    const res = await call(seed.outsider, 'GET', `/conversations/${conversationId}/messages?from=user:${seed.owner}`)
    expect([403, 404]).toContain(res.status)
  })

  test('a malformed from is a 400, not an unfiltered page', async () => {
    const { conversationId } = await channelWithCast()
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages?from=ada`)
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('invalid_from')
  })

  test('from cannot be combined with a thread read', async () => {
    const { conversationId, grace } = await channelWithCast()
    const res = await call(
      seed.owner,
      'GET',
      `/conversations/${conversationId}/messages?from=user:${seed.owner}&threadRootId=${grace.row.id}`,
    )
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('invalid_filter')
  })

  test('the plain timeline is unchanged when from is absent', async () => {
    const { conversationId, ada, grace, alpha, ws } = await channelWithCast()
    const res = await call(seed.owner, 'GET', `/conversations/${conversationId}/messages`)
    expect(res.status).toBe(200)
    // Top-level only, oldest first — the thread replies stay in their thread.
    expect(res.json.messages.map((m: any) => m.id)).toEqual([ada.row.id, grace.row.id, alpha.row.id, ws.row.id])
  })
})
