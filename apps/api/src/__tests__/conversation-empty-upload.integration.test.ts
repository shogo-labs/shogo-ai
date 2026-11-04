// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-303: a chat upload that arrives with no bytes must never become a row.
 *
 * The bug was a composer that lost the file's content and posted the multipart
 * framing alone. The API answered `201` and stored a 0-byte attachment, so the
 * person found out days later, when the download was empty. These tests drive
 * the real router against a real database: an empty upload is refused before
 * anything is written, a one-byte upload still goes through, and a row that is
 * already stored empty says so instead of redirecting to an empty object.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

// Spying on the insert point proves the route refuses the upload *before* it
// touches object storage, not merely that it also skipped the row.
const putCalls: { key: string; size: number }[] = []
const realFiles = await import('../lib/conversation-files')
// Captured before the mock is installed: inside the factory the module's own
// binding is the mock, so calling `realFiles.putConversationFile` would recurse.
const realPutConversationFile = realFiles.putConversationFile
mock.module('../lib/conversation-files', () => ({
  ...realFiles,
  putConversationFile: async (key: string, bytes: Uint8Array, mimeType: string) => {
    putCalls.push({ key, size: bytes.byteLength })
    return realPutConversationFile(key, bytes, mimeType)
  },
}))

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const { storeAgentAttachment } = await import('../services/agent-attachments')

const db = prisma as any
let seed: SeededWorkspace
let channelId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') || null }),
}))

function upload(name: string, type: string, bytes?: Uint8Array) {
  const form = new FormData()
  form.set('file', bytes ? new Blob([bytes], { type }) : new Blob([], { type }), name)
  return form
}

async function postUserUpload(form: FormData) {
  const res = await app.request(`/api/conversations/${channelId}/attachments`, {
    method: 'POST',
    headers: { 'x-user': seed.owner },
    body: form,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function postAgentUpload(form: FormData) {
  const res = await app.request(
    `/api/internal/workspaces/${seed.workspaceId}/agent-channels/design/attachments`,
    { method: 'POST', headers: { 'x-project': seed.projectId }, body: form },
  )
  return { status: res.status, json: await res.json().catch(() => null) }
}

const rowsNamed = (name: string) => db.conversationAttachment.findMany({ where: { name } })

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const created = await app.request(`/api/workspaces/${seed.workspaceId}/conversations`, {
    method: 'POST',
    headers: { 'x-user': seed.owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'design' }),
  })
  expect(created.status).toBe(201)
  channelId = (await created.json()).conversation.id
})

beforeEach(() => {
  putCalls.length = 0
})

afterAll(async () => {
  (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /conversations/:id/attachments', () => {
  test('a 0-byte file is refused with empty_file, and nothing is written', async () => {
    const { status, json } = await postUserUpload(upload('content-agents-kit.zip', 'application/zip'))

    expect(status).toBe(400)
    expect(json.error.code).toBe('empty_file')
    expect(json.error.message).toContain('content-agents-kit.zip')
    expect(json.error.message).toContain('0 bytes')
    // The insert point was never reached: no object, and no row.
    expect(putCalls).toEqual([])
    expect(await rowsNamed('content-agents-kit.zip')).toHaveLength(0)
  })

  test('a 1-byte file still uploads and is stored with size 1', async () => {
    const { status, json } = await postUserUpload(upload('one-byte.zip', 'application/zip', new Uint8Array([7])))

    expect(status).toBe(201)
    expect(json.attachment.size).toBe(1)
    expect(putCalls).toEqual([{ key: expect.any(String), size: 1 }])
    expect(await rowsNamed('one-byte.zip')).toHaveLength(1)
  })
})

describe('agent attachments', () => {
  test('an agent upload of a 0-byte file is refused with empty_file', async () => {
    const { status, json } = await postAgentUpload(upload('empty-clip.mp4', 'video/mp4'))

    expect(status).toBe(400)
    expect(json.error.code).toBe('empty_file')
    expect(await rowsNamed('empty-clip.mp4')).toHaveLength(0)
  })

  test('storeAgentAttachment refuses empty bytes itself, whoever the caller is', async () => {
    await expect(
      storeAgentAttachment({
        workspaceId: seed.workspaceId,
        conversationId: channelId,
        agentRef: 'workspace',
        file: new File([], 'empty-brief.pdf', { type: 'application/pdf' }),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'empty_file' })
    expect(putCalls).toEqual([])
  })
})

describe('GET /conversation-files/:id', () => {
  /** A 0-byte row on a real message, which is what the composer used to store. */
  async function storedEmpty(name: string) {
    const posted = await app.request(`/api/conversations/${channelId}/messages`, {
      method: 'POST',
      headers: { 'x-user': seed.owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${name} attached`, clientMsgId: crypto.randomUUID() }),
    })
    expect(posted.status).toBe(201)
    const messageId = (await posted.json()).message.id
    return db.conversationAttachment.create({
      data: {
        conversationId: channelId,
        messageId,
        uploaderUserId: seed.owner,
        storageKey: `conversations/${seed.workspaceId}/${channelId}/${crypto.randomUUID()}-${name}`,
        name,
        mimeType: 'application/zip',
        size: 0,
      },
    })
  }

  test('a row stored at 0 bytes answers 410 empty_file, not a redirect', async () => {
    const row = await storedEmpty('lost-kit.zip')

    for (const path of [`/api/conversation-files/${row.id}`, `/api/conversation-files/${row.id}?dl=1`]) {
      const res = await app.request(path, { headers: { 'x-user': seed.owner }, redirect: 'manual' })
      expect(res.status).toBe(410)
      expect(res.headers.get('location')).toBeNull()
      const json = await res.json()
      expect(json.error.code).toBe('empty_file')
      expect(json.error.message).toContain('0 bytes')
    }
  })

  test('/meta still describes the empty row, so the client can render the state', async () => {
    const row = await storedEmpty('described-empty.zip')
    const res = await app.request(`/api/conversation-files/${row.id}/meta`, { headers: { 'x-user': seed.owner } })

    expect(res.status).toBe(200)
    expect((await res.json()).file.size).toBe(0)
  })

  test('a non-empty row is still served its bytes', async () => {
    const storageKey = realFiles.buildConversationFileKey(seed.workspaceId, channelId, 'ok.txt')
    await realFiles.putConversationFile(storageKey, new TextEncoder().encode('hello'), 'text/plain')
    const row = await db.conversationAttachment.create({
      data: {
        conversationId: channelId,
        uploaderUserId: seed.owner,
        storageKey,
        name: 'ok.txt',
        mimeType: 'text/plain',
        size: 5,
      },
    })

    const res = await app.request(`/api/conversation-files/${row.id}?dl=1`, { headers: { 'x-user': seed.owner } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })
})
