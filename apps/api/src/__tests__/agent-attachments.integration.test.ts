// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agents upload images and videos: into a channel for a post, or into a
 * board's channel for a card comment or description. Posting links the
 * upload to the message, and only the agent that uploaded a file can attach it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const { workBoardRoutes, agentBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')

const db = prisma as any
let seed: SeededWorkspace
let channelId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
const authorize = async (c: any) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') || null })
app.route('/api/internal', agentChannelRoutes({ authorize }))
app.route('/api/internal', agentBoardRoutes({ authorize }))

async function call(method: string, path: string, opts: { body?: unknown; user?: string; project?: string } = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      ...(opts.user ? { 'x-user': opts.user } : {}),
      ...(opts.project ? { 'x-project': opts.project } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function upload(path: string, name: string, type: string, project?: string) {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type }), name)
  const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}${path}`, {
    method: 'POST',
    headers: project ? { 'x-project': project } : {},
    body: form,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const ws = () => `/internal/workspaces/${seed.workspaceId}`

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const res = await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { user: seed.member, body: { name: 'design' } })
  channelId = res.json.conversation.id
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent channel attachments', () => {
  test('an agent uploads a video and attaches it to its post', async () => {
    const up = await upload('/agent-channels/design/attachments', 'demo.mp4', 'video/mp4', seed.projectId)
    expect(up.status).toBe(201)
    expect(up.json.attachment.url).toMatch(/^\/api\/conversation-files\/.+\?t=/)
    const row = await db.conversationAttachment.findUnique({ where: { id: up.json.attachment.id } })
    expect(row.uploaderUserId).toBeNull()
    expect(row.uploaderAgentRef).toBe(`project:${seed.projectId}`)

    const post = await call('POST', `${ws()}/agent-channels/design/messages`, {
      project: seed.projectId,
      body: { text: 'Cut of the intro', attachmentIds: [up.json.attachment.id] },
    })
    expect(post.status).toBe(201)
    const linked = await db.conversationAttachment.findUnique({ where: { id: up.json.attachment.id } })
    expect(linked.messageId).toBe(post.json.message.id)
  })

  test('another agent cannot attach a file it did not upload', async () => {
    const up = await upload('/agent-channels/design/attachments', 'mine.png', 'image/png', seed.projectId)
    const other = (await db.project.create({ data: { name: 'Other agent', workspaceId: seed.workspaceId } })).id
    await call('POST', `${ws()}/agent-channels/design/messages`, {
      project: other,
      body: { text: 'Borrowing that', attachmentIds: [up.json.attachment.id] },
    })
    const row = await db.conversationAttachment.findUnique({ where: { id: up.json.attachment.id } })
    expect(row.messageId).toBeNull()
  })

  test('the upload needs a file', async () => {
    const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels/design/attachments`, {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(400)
  })
})

describe('agent card attachments', () => {
  test('card media lives in the board channel; a comment carries its attachments', async () => {
    const board = await call('POST', `${ws()}/agent-boards`, {
      body: { channel: 'design', name: 'Assets', columns: [{ name: 'To do', category: 'backlog' }, { name: 'Done', category: 'done' }] },
    })
    expect(board.status).toBe(201)
    const slug = board.json.board.slug

    const hero = await upload(`/agent-boards/${slug}/attachments`, 'hero.png', 'image/png', seed.projectId)
    expect(hero.status).toBe(201)
    const card = await call('POST', `${ws()}/agent-boards/${slug}/items`, {
      project: seed.projectId,
      body: { title: 'Mascot', description: `![Hero](${hero.json.attachment.url}#hero.png)` },
    })
    expect(card.status).toBe(201)
    expect(card.json.item.description).toContain('/api/conversation-files/')
    const heroRow = await db.conversationAttachment.findUnique({ where: { id: hero.json.attachment.id } })
    expect(heroRow.conversationId).toBe(channelId)

    const clip = await upload(`/agent-work-items/${card.json.item.key}/attachments`, 'wave.mp4', 'video/mp4', seed.projectId)
    expect(clip.status).toBe(201)
    const comment = await call('POST', `${ws()}/agent-work-items/${card.json.item.key}/comments`, {
      project: seed.projectId,
      body: { text: '', attachmentIds: [clip.json.attachment.id] },
    })
    expect(comment.status).toBe(201)
    const clipRow = await db.conversationAttachment.findUnique({ where: { id: clip.json.attachment.id } })
    expect(clipRow.messageId).toBe(comment.json.messageId)
    expect(clipRow.conversationId).toBe(channelId)
  })
})
