// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-412 acceptance, through the routes the app and the agent runtime call:
 * "Open chat" on an agent lands in that person's own project chat (a workspace
 * chat for the workspace agent), `team_chat_dm` delivers into that chat with a
 * push, an old `/c/<agentDmId>` link reports the chat it became, and the
 * migration is a no-op on a second run.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const pushes: Array<{ userId: string; title?: string; body?: string }> = []

const { mock } = await import('bun:test')
const realPush = await import('../lib/push-notifications')
mock.module('../lib/push-notifications', () => ({
  ...realPush,
  sendPushToUser: async (userId: string, payload: any) => {
    pushes.push({ userId, title: payload?.title, body: payload?.body })
    return { sent: true }
  },
}))

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const agentChat = await import('../services/agent-chat.service')
const service = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') ?? null }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function asAgent(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels${path}`, {
    method,
    headers: { 'x-project': seed.projectId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  pushes.length = 0
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('Open chat on an agent', () => {
  test('POST /workspaces/:id/agent-chat creates the person\'s project chat and reuses it', async () => {
    const first = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/agent-chat`, { projectId: seed.projectId })
    expect(first.status).toBe(200)
    expect(typeof first.json.chatSessionId).toBe('string')

    const again = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/agent-chat`, { projectId: seed.projectId })
    expect(again.json.chatSessionId).toBe(first.json.chatSessionId)

    const row = await db.chatSession.findUnique({ where: { id: first.json.chatSessionId } })
    expect(row.contextType).toBe('project')
    expect(row.contextId).toBe(seed.projectId)
    expect(row.createdByUserId).toBe(seed.member)
  })

  test('the workspace agent opens a workspace chat, not a project one', async () => {
    const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/agent-chat`, {})
    expect(res.status).toBe(200)
    const row = await db.chatSession.findUnique({ where: { id: res.json.chatSessionId } })
    expect(row.contextType).toBe('workspace')
    expect(row.workspaceId).toBe(seed.workspaceId)
  })

  test('a project in another workspace is refused', async () => {
    const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/agent-chat`, { projectId: seed.foreignProjectId })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('team_chat_dm delivers into the person\'s chat with the agent', () => {
  test('the message lands in that chat and pushes a notification', async () => {
    const res = await asAgent('POST', '/dm', { user: seed.viewer, text: 'Your build is green.' })
    expect(res.status).toBe(201)
    const chatSessionId = res.json.message.conversationId
    expect(typeof chatSessionId).toBe('string')

    const session = await db.chatSession.findUnique({ where: { id: chatSessionId } })
    expect(session.directKey).toBe(`a:${seed.workspaceId}:${seed.viewer}:${seed.projectId}`)
    expect(session.createdByUserId).toBe(seed.viewer)

    const messages = await db.chatMessage.findMany({ where: { sessionId: chatSessionId }, orderBy: { createdAt: 'asc' } })
    expect(messages.map((m: any) => m.content)).toContain('Your build is green.')
    expect(messages.every((m: any) => m.role === 'assistant')).toBe(true)

    expect(pushes.some((p) => p.userId === seed.viewer && p.body === 'Your build is green.')).toBe(true)
  })

  test('a second message reuses the same chat', async () => {
    const one = await asAgent('POST', '/dm', { user: seed.owner, text: 'one' })
    const two = await asAgent('POST', '/dm', { user: seed.owner, text: 'two' })
    expect(two.json.message.conversationId).toBe(one.json.message.conversationId)
  })

  test('for_requester still posts a person-to-person DM, not an agent chat', async () => {
    const res = await asAgent('POST', '/dm', {
      user: seed.viewer,
      text: 'Sent on your behalf.',
      onBehalfOfUserId: seed.member,
    })
    expect(res.status).toBe(201)
    const conversation = await db.conversation.findUnique({ where: { id: res.json.message.conversationId } })
    expect(conversation.kind).toBe('dm')
    expect(conversation.dmKey.startsWith('a:')).toBe(false)
  })
})

describe('an old /c/<agentDmId> link', () => {
  test('reports the chat the DM became, so the client redirects', async () => {
    const project = await db.project.create({ data: { name: 'Redirect Bot', workspaceId: seed.workspaceId } })
    const dm = await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: project.id })
    await db.conversationMessage.create({
      data: {
        conversationId: dm.id,
        workspaceId: seed.workspaceId,
        seq: 1,
        authorType: 'user',
        authorUserId: seed.owner,
        text: 'You are Redirect Bot, a teammate in a direct message…',
      },
    })

    await agentChat.migrateAgentDmsToProjectChat()

    const res = await call(seed.owner, 'GET', `/conversations/${dm.id}`)
    expect(res.status).toBe(200)
    const chatSessionId = res.json.conversation.movedToChatSessionId
    expect(typeof chatSessionId).toBe('string')

    const chat = await db.chatSession.findUnique({ where: { id: chatSessionId } })
    expect(chat.directKey).toBe(`a:${seed.workspaceId}:${seed.owner}:${project.id}`)
    expect(chat.createdByUserId).toBe(seed.owner)
  })

  test('a person DM reports no moved chat', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.member, [seed.owner])
    const res = await call(seed.member, 'GET', `/conversations/${dm.id}`)
    expect(res.status).toBe(200)
    expect(res.json.conversation.movedToChatSessionId ?? null).toBeNull()
  })
})

describe('the migration is idempotent', () => {
  test('a second run creates no chats and copies no messages', async () => {
    const before = await db.chatSession.count()
    const beforeMessages = await db.chatMessage.count()
    const summary = await agentChat.migrateAgentDmsToProjectChat()
    expect(summary.conversations).toBe(0)
    expect(await db.chatSession.count()).toBe(before)
    expect(await db.chatMessage.count()).toBe(beforeMessages)
  })
})

describe('the migration leaves bridged DMs alone', () => {
  test('a Slack DM is not migrated, archived or logged as a failure', async () => {
    const bridged = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'dm', dmKey: 'a:ext:slack:D_OWNER' },
    })
    await db.conversationMessage.create({
      data: {
        conversationId: bridged.id,
        workspaceId: seed.workspaceId,
        seq: 1,
        authorType: 'user',
        authorUserId: seed.owner,
        text: 'hello from slack',
      },
    })

    const summary = await agentChat.migrateAgentDmsToProjectChat()

    // `a:ext:<provider>:<channelId>` is a bridged DM, not an agent DM: the
    // migration must not count it, must not try to build a chat for it, and
    // must leave the conversation live so the bridge keeps working.
    expect(summary.conversations).toBe(0)
    expect(summary.skipped).toBe(0)
    const after = await db.conversation.findUnique({ where: { id: bridged.id } })
    expect(after.archivedAt).toBeNull()
    expect(await db.chatSession.count({ where: { directKey: { contains: 'ext:slack' } } })).toBe(0)
  })
})

describe('a DM whose chat already exists', () => {
  test('keeps its transcript instead of being archived empty', async () => {
    const project = await db.project.create({ data: { name: 'Race Bot', workspaceId: seed.workspaceId } })
    const dm = await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: project.id })
    await db.conversationMessage.create({
      data: {
        conversationId: dm.id,
        workspaceId: seed.workspaceId,
        seq: 1,
        authorType: 'user',
        authorUserId: seed.owner,
        text: 'the history I care about',
      },
    })

    // The person taps "Open chat" (or an agent messages them) before the boot
    // migration reaches this DM, so the chat exists and is still empty.
    const opened = await agentChat.openAgentChatSession(seed.workspaceId, seed.owner, project.id)

    await agentChat.migrateAgentDmsToProjectChat()

    const messages = await db.chatMessage.findMany({ where: { sessionId: opened.id } })
    expect(messages.map((m: any) => m.content)).toContain('the history I care about')
  })
})
