// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The file viewer's two routes: what a file is, and its text.
 *
 * Driven through the real router against a real SQLite database, because the
 * point of these routes is who may look: a channel member gets the file, an
 * outsider and a deleted message's attachment get the same 404, and neither
 * route ever answers with a redirect to storage — a redirect is how a tap on a
 * shared file ended up in a browser tab.
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
  return { status: res.status, json, res }
}

async function postMessage(user: string, conversationId: string, text: string): Promise<string> {
  const res = await call(user, 'POST', `/conversations/${conversationId}/messages`, {
    text,
    clientMsgId: crypto.randomUUID(),
  })
  expect(res.status).toBe(201)
  return res.json.message.id
}

async function attach(
  conversationId: string,
  messageId: string,
  file: { name: string; mimeType: string; extractedText?: string | null },
): Promise<string> {
  const row = await db.conversationAttachment.create({
    data: {
      conversationId,
      messageId,
      uploaderUserId: seed.member,
      storageKey: `conversations/${seed.workspaceId}/${conversationId}/${crypto.randomUUID()}-${file.name}`,
      name: file.name,
      mimeType: file.mimeType,
      size: 42,
      extractedText: file.extractedText ?? null,
    },
  })
  return row.id
}

async function newChannel(name: string): Promise<string> {
  const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name })
  expect(res.status).toBe(201)
  return res.json.conversation.id
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /conversation-files/:id/meta', () => {
  test('describes a file for a channel member, with a download URL and text available', async () => {
    const conversationId = await newChannel('viewer-meta')
    const messageId = await postMessage(seed.member, conversationId, 'here is the doc')
    const attachmentId = await attach(conversationId, messageId, {
      name: 'notes.md',
      mimeType: 'text/markdown',
      extractedText: '# Notes',
    })

    const res = await call(seed.member, 'GET', `/conversation-files/${attachmentId}/meta`)
    expect(res.status).toBe(200)
    expect(res.json.file).toMatchObject({
      id: attachmentId,
      name: 'notes.md',
      mimeType: 'text/markdown',
      messageId,
      conversationId,
      hasText: true,
    })
    // A capability URL the viewer can download from — never a redirect here.
    expect(res.json.file.url).toContain(`/api/conversation-files/${attachmentId}`)
    expect(res.json.conversation.id).toBe(conversationId)
  })

  test('a file nothing can read is still described, with no text', async () => {
    const conversationId = await newChannel('viewer-binary')
    const messageId = await postMessage(seed.member, conversationId, 'binary')
    const attachmentId = await attach(conversationId, messageId, { name: 'archive.zip', mimeType: 'application/zip' })

    const res = await call(seed.member, 'GET', `/conversation-files/${attachmentId}/meta`)
    expect(res.status).toBe(200)
    expect(res.json.file.hasText).toBe(false)

    const text = await call(seed.member, 'GET', `/conversation-files/${attachmentId}/text`)
    expect(text.status).toBe(200)
    expect(text.json.text).toBeNull()
  })

  test("someone outside the channel can't tell the file exists", async () => {
    const conversationId = await newChannel('viewer-private')
    const messageId = await postMessage(seed.member, conversationId, 'private')
    const attachmentId = await attach(conversationId, messageId, {
      name: 'secret.txt',
      mimeType: 'text/plain',
      extractedText: 'secret',
    })

    expect((await call(seed.outsider, 'GET', `/conversation-files/${attachmentId}/meta`)).status).toBe(404)
    expect((await call(seed.outsider, 'GET', `/conversation-files/${attachmentId}/text`)).status).toBe(404)
    expect((await call(seed.member, 'GET', `/conversation-files/${attachmentId}/meta`)).status).toBe(200)
  })

  test("a file on a deleted message is gone, even for the person who posted it", async () => {
    const conversationId = await newChannel('viewer-deleted')
    const messageId = await postMessage(seed.member, conversationId, 'about to go')
    const attachmentId = await attach(conversationId, messageId, {
      name: 'gone.txt',
      mimeType: 'text/plain',
      extractedText: 'gone',
    })

    expect((await call(seed.member, 'DELETE', `/conversation-messages/${messageId}`)).status).toBe(200)
    expect((await call(seed.member, 'GET', `/conversation-files/${attachmentId}/meta`)).status).toBe(404)
    expect((await call(seed.member, 'GET', `/conversation-files/${attachmentId}/text`)).status).toBe(404)
  })

  test('an id that never existed is a 404, not an error', async () => {
    expect((await call(seed.member, 'GET', `/conversation-files/does-not-exist/meta`)).status).toBe(404)
  })
})

describe('GET /conversation-files/:id/text', () => {
  test('returns the stored text a viewer can render', async () => {
    const conversationId = await newChannel('viewer-text')
    const messageId = await postMessage(seed.member, conversationId, 'the notes')
    const attachmentId = await attach(conversationId, messageId, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      extractedText: 'line one\nline two',
    })

    const res = await call(seed.member, 'GET', `/conversation-files/${attachmentId}/text`)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      fileId: attachmentId,
      name: 'notes.txt',
      text: 'line one\nline two',
      totalChars: 17,
      nextOffset: null,
    })
  })

  test('pages long text by offset', async () => {
    const conversationId = await newChannel('viewer-text-pages')
    const messageId = await postMessage(seed.member, conversationId, 'a log')
    const attachmentId = await attach(conversationId, messageId, {
      name: 'big.log',
      mimeType: 'text/plain',
      extractedText: 'abcdefghij',
    })

    const first = await call(seed.member, 'GET', `/conversation-files/${attachmentId}/text?offset=0&limit=4`)
    expect(first.json.text).toBe('abcd')
    expect(first.json.nextOffset).toBe(4)

    const second = await call(seed.member, 'GET', `/conversation-files/${attachmentId}/text?offset=4&limit=4`)
    expect(second.json.text).toBe('efgh')
  })
})
