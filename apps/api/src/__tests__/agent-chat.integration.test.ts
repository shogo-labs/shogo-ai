// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A DM with an agent is a project chat with that agent (SHO-412).
 *
 * Covers the three pieces that make that true: opening the chat (find or
 * create, never a duplicate), an agent's message to a person landing in it with
 * a push, and the one-time migration that moves every existing agent DM into
 * one — including the empty DM, thread replies, attachments and a re-run.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const pushes: Array<{ userId: string; title?: string; body?: string }> = []
const region = { where: null as any }

// The push sender would hit Expo; the region filter is what the migration
// spreads into its query, so both are stubbed before the service loads.
const { mock } = await import('bun:test')
const realPush = await import('../lib/push-notifications')
mock.module('../lib/push-notifications', () => ({
  ...realPush,
  sendPushToUser: async (userId: string, payload: any) => {
    pushes.push({ userId, title: payload?.title, body: payload?.body })
    return { sent: true }
  },
}))
const realRegion = await import('../lib/region')
mock.module('../lib/region', () => ({
  ...realRegion,
  homeRegionWorkspaceWhere: () => region.where,
}))

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const agentChat = await import('../services/agent-chat.service')
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
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  pushes.length = 0
  region.where = null
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** An agent DM the way the old surface created it, with a backing session. */
async function seedAgentDm(opts: {
  userId: string
  projectId: string | null
  messages?: Array<{
    authorType: 'user' | 'agent' | 'system'
    text: string
    threadRootId?: string | null
    agentSessionId?: string | null
    attachment?: boolean
  }>
}) {
  const conversation = await service.openAgentConversation(seed.workspaceId, opts.userId, { projectId: opts.projectId })
  let seq = 0
  const rows: any[] = []
  for (const m of opts.messages ?? []) {
    seq++
    const row = await db.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        workspaceId: seed.workspaceId,
        seq,
        authorType: m.authorType,
        authorUserId: m.authorType === 'user' ? opts.userId : null,
        text: m.text,
        threadRootId: m.threadRootId ?? null,
        agentSessionId: m.agentSessionId ?? null,
      },
    })
    if (m.attachment) {
      await db.conversationAttachment.create({
        data: {
          conversationId: conversation.id,
          messageId: row.id,
          uploaderUserId: opts.userId,
          storageKey: `artifacts/test/${row.id}`,
          name: 'brief.pdf',
          mimeType: 'application/pdf',
          size: 12,
        },
      })
    }
    rows.push(row)
  }
  return { conversation, rows }
}

describe('opening a chat with an agent', () => {
  test('creates one project chat and reuses it, owned by the person', async () => {
    const first = await agentChat.openAgentChatSession(seed.workspaceId, seed.member, seed.projectId)
    const second = await agentChat.openAgentChatSession(seed.workspaceId, seed.member, seed.projectId)
    expect(second.id).toBe(first.id)

    const row = await db.chatSession.findUnique({ where: { id: first.id } })
    expect(row.contextType).toBe('project')
    expect(row.contextId).toBe(seed.projectId)
    expect(row.createdByUserId).toBe(seed.member)
    expect(row.directKey).toBe(`a:${seed.workspaceId}:${seed.member}:${seed.projectId}`)

    const all = await db.chatSession.findMany({ where: { directKey: row.directKey } })
    expect(all.length).toBe(1)
  })

  test('the workspace agent gets a workspace chat, not a project one', async () => {
    const chat = await agentChat.openAgentChatSession(seed.workspaceId, seed.member, null)
    const row = await db.chatSession.findUnique({ where: { id: chat.id } })
    expect(row.contextType).toBe('workspace')
    expect(row.workspaceId).toBe(seed.workspaceId)
    expect(row.contextId).toBeNull()
  })

  test('two people get two chats with the same agent', async () => {
    const mine = await agentChat.openAgentChatSession(seed.workspaceId, seed.member, seed.projectId)
    const theirs = await agentChat.openAgentChatSession(seed.workspaceId, seed.owner, seed.projectId)
    expect(theirs.id).not.toBe(mine.id)
  })
})

describe('an agent messaging a person', () => {
  test('appends an assistant row to their chat with it and pushes', async () => {
    const delivered = await agentChat.deliverAgentDirectMessage({
      workspaceId: seed.workspaceId,
      userId: seed.viewer,
      projectId: seed.projectId,
      text: 'The deploy is green.',
    })

    const row = await db.chatMessage.findUnique({ where: { id: delivered.messageId } })
    expect(row.sessionId).toBe(delivered.chatSessionId)
    expect(row.role).toBe('assistant')
    expect(row.content).toBe('The deploy is green.')

    const session = await db.chatSession.findUnique({ where: { id: delivered.chatSessionId } })
    expect(session.createdByUserId).toBe(seed.viewer)

    expect(pushes).toEqual([{ userId: seed.viewer, title: 'Billing Bot', body: 'The deploy is green.' }])
  })

  test('a second message lands in the same chat', async () => {
    const one = await agentChat.deliverAgentDirectMessage({
      workspaceId: seed.workspaceId, userId: seed.viewer, projectId: seed.projectId, text: 'one',
    })
    const two = await agentChat.deliverAgentDirectMessage({
      workspaceId: seed.workspaceId, userId: seed.viewer, projectId: seed.projectId, text: 'two',
    })
    expect(two.chatSessionId).toBe(one.chatSessionId)
    const rows = await db.chatMessage.findMany({ where: { sessionId: one.chatSessionId }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r: any) => r.content).slice(-2)).toEqual(['one', 'two'])
  })
})

describe('POST /workspaces/:id/dms { agent }', () => {
  test('answers 410 moved_to_project_chat with the chat to open', async () => {
    const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/dms`, { agent: { projectId: seed.projectId } })
    expect(res.status).toBe(410)
    expect(res.json.error.code).toBe('moved_to_project_chat')
    expect(typeof res.json.chatSessionId).toBe('string')

    const session = await db.chatSession.findUnique({ where: { id: res.json.chatSessionId } })
    expect(session.directKey).toBe(`a:${seed.workspaceId}:${seed.member}:${seed.projectId}`)
  })

  test('a person DM still opens a conversation', async () => {
    const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.owner] })
    expect(res.status).toBe(200)
    expect(res.json.conversation.kind).toBe('dm')
  })
})

describe('migrating existing agent DMs', () => {
  test('copies the visible transcript, flattens threads, carries attachments and retires the DM', async () => {
    // A project nobody has opened a chat with yet, so the migration is what
    // creates the chat.
    const project = await db.project.create({ data: { name: 'Billing Bot', workspaceId: seed.workspaceId } })
    const backing = await db.chatSession.create({
      data: { inferredName: 'agent dm', contextType: 'project', contextId: project.id },
      select: { id: true },
    })
    const { conversation, rows } = await seedAgentDm({
      userId: seed.owner,
      projectId: project.id,
      messages: [
        { authorType: 'user', text: 'You are Billing Bot, a teammate in a direct message…' },
        { authorType: 'agent', text: 'Happy to help.', agentSessionId: backing.id },
        { authorType: 'system', text: 'Billing Bot joined' },
      ],
    })
    // A thread reply and its answer, plus an attachment on the reply.
    const root = rows[0].id
    const reply = await db.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        workspaceId: seed.workspaceId,
        seq: 4,
        authorType: 'user',
        authorUserId: seed.owner,
        text: 'Send the invoice',
        threadRootId: root,
      },
    })
    await db.conversationAttachment.create({
      data: {
        conversationId: conversation.id,
        messageId: reply.id,
        uploaderUserId: seed.owner,
        storageKey: `artifacts/test/${reply.id}`,
        name: 'brief.pdf',
        mimeType: 'application/pdf',
        size: 12,
      },
    })
    await db.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        workspaceId: seed.workspaceId,
        seq: 5,
        authorType: 'agent',
        text: 'Sent.',
        threadRootId: root,
        agentSessionId: backing.id,
      },
    })

    const summary = await agentChat.migrateAgentDmsToProjectChat()
    expect(summary.sessionsCreated).toBeGreaterThanOrEqual(1)

    const chat = await db.chatSession.findUnique({
      where: { directKey: `a:${seed.workspaceId}:${seed.owner}:${project.id}` },
    })
    expect(chat).toBeTruthy()
    expect(chat.createdByUserId).toBe(seed.owner)

    const copied = await db.chatMessage.findMany({ where: { sessionId: chat.id }, orderBy: { createdAt: 'asc' } })
    expect(copied.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(copied.map((m: any) => m.content)).toEqual([
      'You are Billing Bot, a teammate in a direct message…',
      'Happy to help.',
      'Send the invoice',
      'Sent.',
    ])
    // The attachment rides along as a file part on the person's message.
    const parts = JSON.parse(copied[2].parts)
    expect(parts[0]).toEqual({ type: 'text', text: 'Send the invoice' })
    expect(parts[1]).toMatchObject({ type: 'file', name: 'brief.pdf', mediaType: 'application/pdf' })

    // The wrapper-prompt session is handed to the person and archived.
    const retired = await db.chatSession.findUnique({ where: { id: backing.id } })
    expect(retired.createdByUserId).toBe(seed.owner)
    expect(retired.isArchived).toBe(true)

    // The DM itself is archived, so it stops showing up.
    const dm = await db.conversation.findUnique({ where: { id: conversation.id } })
    expect(dm.archivedAt).toBeTruthy()
  })

  test('an empty DM is archived without creating a chat', async () => {
    const dmKey = `a:${seed.viewer}:${seed.foreignProjectId}`
    const dm = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'dm', dmKey },
    })
    const summary = await agentChat.migrateAgentDmsToProjectChat()
    expect(summary.emptyArchived).toBeGreaterThanOrEqual(1)

    const archived = await db.conversation.findUnique({ where: { id: dm.id } })
    expect(archived.archivedAt).toBeTruthy()
    const chat = await db.chatSession.findUnique({
      where: { directKey: `a:${seed.workspaceId}:${seed.viewer}:${seed.foreignProjectId}` },
    })
    expect(chat).toBeNull()
  })

  test('running it again changes nothing', async () => {
    const before = await db.chatSession.count()
    const beforeMessages = await db.chatMessage.count()
    const summary = await agentChat.migrateAgentDmsToProjectChat()
    expect(summary.conversations).toBe(0)
    expect(await db.chatSession.count()).toBe(before)
    expect(await db.chatMessage.count()).toBe(beforeMessages)
  })

  test('cloud: the home-region filter reaches the query', async () => {
    region.where = { homeRegion: 'eu-frankfurt-1' }
    const seen: any[] = []
    const original = db.conversation.findMany
    db.conversation.findMany = async (args: any) => {
      seen.push(args?.where)
      return []
    }
    try {
      await agentChat.migrateAgentDmsToProjectChat()
    } finally {
      db.conversation.findMany = original
    }
    expect(seen[0]).toMatchObject({ workspace: { homeRegion: 'eu-frankfurt-1' } })
  })
})
