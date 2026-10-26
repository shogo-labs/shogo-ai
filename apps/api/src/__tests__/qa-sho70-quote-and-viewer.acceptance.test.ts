// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA gate for SHO-70 — the server half of "a shared message link renders as a
 * quote, and a shared file opens a viewer".
 *
 * Two things only the server can get right, driven through the real router
 * against a real SQLite database:
 *
 * 1. A quote is per viewer. The route that feeds it must answer a channel
 *    member with the message and answer an outsider with a 404 — never a
 *    redacted 200 that the client then prints — and it must carry enough to
 *    label the channel (acceptance criterion 1: channel, author, snippet,
 *    time).
 * 2. A link to our own app is never unfurled: a `/c/…?msg=` or `/f/…` URL can
 *    only ever produce a useless preview card (our SPA shell) next to the
 *    quote that already renders the same reference. A foreign link must still
 *    unfurl, so the check cannot be "skip everything".
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const unfurl = await import('../services/conversation-unfurl')

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
  return { status: res.status, json, res }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('a message link can be quoted for the viewer who is looking', () => {
  async function channelWithMessage(name: string, text: string) {
    const created = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name })
    expect(created.status).toBe(201)
    const conversationId = created.json.conversation.id
    const posted = await call(seed.member, 'POST', `/conversations/${conversationId}/messages`, {
      text,
      clientMsgId: crypto.randomUUID(),
    })
    expect(posted.status).toBe(201)
    return { conversationId, messageId: posted.json.message.id }
  }

  test('the quote target is readable by a member, with its author and text', async () => {
    const { messageId } = await channelWithMessage('qa70-quote', 'the detail you wanted')
    const res = await call(seed.member, 'GET', `/conversation-messages/${messageId}`)

    expect(res.status).toBe(200)
    expect(res.json.message.id).toBe(messageId)
    expect(res.json.message.text).toBe('the detail you wanted')
    expect(res.json.message.authorUser?.id ?? res.json.message.authorUserId).toBe(seed.member)
  })

  test('the quote target names its channel, so the card can label it', async () => {
    // Acceptance criterion 1: channel, author, snippet, time. Author and time
    // ride on the message; the channel has to come with it, or the card has to
    // make a second call it has no id for.
    const { conversationId, messageId } = await channelWithMessage('qa70-label', 'in this channel')
    const res = await call(seed.member, 'GET', `/conversation-messages/${messageId}`)

    expect(res.status).toBe(200)
    expect(res.json.message.conversation ?? res.json.conversation).toMatchObject({
      id: conversationId,
      name: 'qa70-label',
      kind: 'public',
    })
  })

  test('an outsider gets no message at all — no redacted 200 to print', async () => {
    const { messageId } = await channelWithMessage('qa70-private', 'nobody else should read this')
    const res = await call(seed.outsider, 'GET', `/conversation-messages/${messageId}`)

    expect(res.status).toBe(404)
    const body = JSON.stringify(res.json ?? {})
    expect(body).not.toContain('nobody else should read this')
  })
})

describe('a link to our own app is never unfurled', () => {
  const own = 'https://qa70.example.test'

  test('a message link on our own origin produces no preview card', () => {
    const before = process.env.APP_URL
    process.env.APP_URL = own
    try {
      expect(unfurl.extractLinks(`look at this ${own}/c/abc?msg=123`)).toEqual([])
    } finally {
      if (before === undefined) delete process.env.APP_URL
      else process.env.APP_URL = before
    }
  })

  test('a shared file link on our own origin produces no preview card', () => {
    const before = process.env.APP_URL
    process.env.APP_URL = own
    try {
      expect(unfurl.extractLinks(`here it is ${own}/f/att-123`)).toEqual([])
    } finally {
      if (before === undefined) delete process.env.APP_URL
      else process.env.APP_URL = before
    }
  })

  test('a foreign link still unfurls, so the skip is not "skip everything"', () => {
    const before = process.env.APP_URL
    process.env.APP_URL = own
    try {
      expect(unfurl.extractLinks(`see ${own}/c/abc?msg=123 and https://elsewhere.dev/post`)).toEqual([
        'https://elsewhere.dev/post',
      ])
    } finally {
      if (before === undefined) delete process.env.APP_URL
      else process.env.APP_URL = before
    }
  })
})
