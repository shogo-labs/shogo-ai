// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared message / conversation link previews, against a real database.
 *
 * The contract under test is access control, not rendering: what a link may
 * reveal is decided per reader, on every request, and a reader who cannot open
 * the conversation must learn nothing — not the text, not the channel name, and
 * not even that the conversation exists.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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

async function newChannel(name: string, kind: 'public' | 'private', owner = seed.owner) {
  const res = await call(owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, kind })
  expect(res.status).toBe(201)
  return res.json.conversation.id as string
}

async function post(channelId: string, text: string, user = seed.owner, extra: Record<string, unknown> = {}) {
  const res = await call(user, 'POST', `/conversations/${channelId}/messages`, {
    text,
    clientMsgId: crypto.randomUUID(),
    ...extra,
  })
  expect(res.status).toBe(201)
  return res.json.message
}

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

describe('message link previews', () => {
  test('a public channel message is previewable by any workspace member', async () => {
    const channelId = await newChannel('public-preview', 'public')
    const message = await post(channelId, 'the 2.6.0 email goes out Monday')

    // `viewer` is not a member of this channel — a public channel is still open.
    const res = await call(seed.viewer, 'GET', `/conversation-messages/${message.id}/preview`)
    expect(res.status).toBe(200)
    expect(res.json.message.authorName).toBeTruthy()
    expect(res.json.message.text).toBe('the 2.6.0 email goes out Monday')
    expect(res.json.conversation.id).toBe(channelId)
    expect(res.json.conversation.kind).toBe('public')
    expect(res.json.conversation.private).toBe(false)
  })

  test('a private channel message is previewable only by its members', async () => {
    const channelId = await newChannel('private-preview', 'private')
    const message = await post(channelId, 'secret roadmap')

    const mine = await call(seed.owner, 'GET', `/conversation-messages/${message.id}/preview`)
    expect(mine.status).toBe(200)
    expect(mine.json.conversation.private).toBe(true)
    expect(mine.json.message.text).toBe('secret roadmap')

    const theirs = await call(seed.member, 'GET', `/conversation-messages/${message.id}/preview`)
    expect(theirs.status).toBe(404)
    // Nothing about the conversation leaks through the refusal.
    expect(JSON.stringify(theirs.json)).not.toContain('secret roadmap')
    expect(JSON.stringify(theirs.json)).not.toContain('private-preview')
  })

  test('somebody outside the workspace learns nothing', async () => {
    const channelId = await newChannel('public-outsider', 'public')
    const message = await post(channelId, 'internal only')
    const res = await call(seed.outsider, 'GET', `/conversation-messages/${message.id}/preview`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.json)).not.toContain('internal only')
  })

  test('an unknown message id is the same refusal as no access', async () => {
    const res = await call(seed.owner, 'GET', '/conversation-messages/does-not-exist/preview')
    expect(res.status).toBe(404)
  })

  test('a deleted message previews as a tombstone, never as its old text', async () => {
    const channelId = await newChannel('deleted-preview', 'public')
    const message = await post(channelId, 'regrettable words')
    const removed = await call(seed.owner, 'DELETE', `/conversation-messages/${message.id}`)
    expect(removed.status).toBe(200)

    const res = await call(seed.member, 'GET', `/conversation-messages/${message.id}/preview`)
    expect(res.status).toBe(200)
    expect(res.json.message.deleted).toBe(true)
    expect(res.json.message.text).toBe('')
  })

  test('a long message is truncated and says so', async () => {
    const channelId = await newChannel('long-preview', 'public')
    const message = await post(channelId, 'x'.repeat(900))
    const res = await call(seed.member, 'GET', `/conversation-messages/${message.id}/preview`)
    expect(res.status).toBe(200)
    expect(res.json.message.text.length).toBe(400)
    expect(res.json.message.truncated).toBe(true)
  })

  test('a thread reply keeps its root so the card can say so', async () => {
    const channelId = await newChannel('thread-preview', 'public')
    const root = await post(channelId, 'starting point')
    const reply = await post(channelId, 'a reply', seed.owner, { threadRootId: root.id })
    const res = await call(seed.member, 'GET', `/conversation-messages/${reply.id}/preview`)
    expect(res.status).toBe(200)
    expect(res.json.message.threadRootId).toBe(root.id)
  })
})

describe('conversation link previews', () => {
  test('a public channel previews for the workspace with its name', async () => {
    const channelId = await newChannel('conv-public', 'public')
    const res = await call(seed.member, 'GET', `/conversations/${channelId}/preview`)
    expect(res.status).toBe(200)
    expect(res.json.conversation.name).toBe('conv-public')
    expect(res.json.conversation.private).toBe(false)
  })

  test('a private channel is refused to a non-member', async () => {
    const channelId = await newChannel('conv-private', 'private')
    expect((await call(seed.member, 'GET', `/conversations/${channelId}/preview`)).status).toBe(404)
    expect((await call(seed.owner, 'GET', `/conversations/${channelId}/preview`)).status).toBe(200)
  })

  test('a DM previews under the other participant\u2019s name, to participants only', async () => {
    const dm = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.member] })
    expect(dm.status).toBe(200)
    const dmId = dm.json.conversation.id as string

    const mine = await call(seed.owner, 'GET', `/conversations/${dmId}/preview`)
    expect(mine.status).toBe(200)
    expect(mine.json.conversation.private).toBe(true)
    expect(mine.json.conversation.name).toContain('member')

    // A workspace member who is not in the DM sees nothing at all.
    expect((await call(seed.viewer, 'GET', `/conversations/${dmId}/preview`)).status).toBe(404)
  })
})

describe('the sender\u2019s opt-out', () => {
  test('a declined preview is stored on the message, not the preview itself', async () => {
    const channelId = await newChannel('optout', 'public')
    const href = `https://studio.shogo.ai/c/${channelId}?msg=abc`

    const message = await post(channelId, `see ${href}`, seed.owner, { linkPreviewsOff: [href] })
    expect(message.blocks.linkPreviewsOff).toEqual([href])

    // Storing the refusal must never store the linked conversation's content.
    expect(JSON.stringify(message.blocks)).not.toContain('text')
  })

  test('junk in the field cannot grow the block', async () => {
    const channelId = await newChannel('optout-junk', 'public')
    const message = await post(channelId, 'nothing', seed.owner, {
      linkPreviewsOff: ['not a url', 42, null, { url: 'x' }, 'https://studio.shogo.ai/c/x'],
    })
    expect(message.blocks.linkPreviewsOff).toEqual(['https://studio.shogo.ai/c/x'])
  })

  test('no opt-out means no block at all', async () => {
    const channelId = await newChannel('optout-empty', 'public')
    const message = await post(channelId, 'plain message', seed.owner)
    expect(message.blocks).toBeNull()
  })
})
