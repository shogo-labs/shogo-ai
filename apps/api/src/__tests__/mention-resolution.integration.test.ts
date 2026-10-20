// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-69: a plain `@Name` typed in prose — a card comment, a channel post, an
 * approval or an automation — must tag its agent or person from every entry
 * point, because the resolution happens where the message row is inserted.
 * Also pins the ambiguous-name warning and that mirrored external channels are
 * left alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const { workBoardRoutes, agentBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const notifications = await import('../services/conversation-notifications')

const db = prisma as any
let seed: SeededWorkspace
let planner: string
let dev1: string
let channelId: string
let boardId: string
let agentAuth: { projectId: string | null | undefined } = { projectId: null }

interface Invocation { projectId: string | null; sessionId: string; userId: string; prompt: string }
let invocations: Invocation[] = []
let pushes: Array<{ userId: string; title: string; body: string }> = []

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: agentAuth.projectId }),
}))
app.route('/api/internal', agentBoardRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') || undefined }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const asAgent = (method: string, path: string, body?: unknown) =>
  call(null, method, `/internal/workspaces/${seed.workspaceId}${path}`, body)

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const mk = (name: string) =>
    db.project.create({ data: { name, workspaceId: seed.workspaceId } }).then((p: any) => p.id)
  planner = await mk('Shogo Planner')
  dev1 = await mk('Shogo Dev 1')
  await mk('New Project')
  await mk('New Project')

  notifications.registerConversationNotifications()
  notifications._setPushSenderForTests(async (userId, payload) => {
    pushes.push({ userId, title: payload.title, body: payload.body })
  })

  const channel = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'dev' })
  channelId = channel.json.conversation.id
  const board = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/boards`, { conversationId: channelId, name: 'Shogo Dev' })
  boardId = board.json.board.id
})

afterAll(async () => {
  notifications._setPushSenderForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  invocations = []
  pushes = []
  agentAuth = { projectId: null }
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, sessionId: args.sessionId, userId: args.userId, prompt: args.prompt })
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Noted.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

async function card(title: string): Promise<{ id: string; key: string }> {
  const res = await call(seed.owner, 'POST', `/boards/${boardId}/items`, { title })
  expect(res.status).toBe(201)
  return { id: res.json.item.id, key: res.json.item.key }
}

async function addMember(userId: string) {
  const existing = await db.conversationMember.findFirst({ where: { conversationId: channelId, userId } })
  if (!existing) await db.conversationMember.create({ data: { conversationId: channelId, memberType: 'user', userId } })
}

async function mentionRows(messageId: string) {
  return db.conversationMention.findMany({ where: { messageId } })
}

describe('a plain @Name typed in prose tags on every post path', () => {
  test('an agent’s card comment resolves the tail, records the mention and wakes that agent once', async () => {
    const item = await card('Mentions in prose')
    agentAuth = { projectId: planner }
    const res = await asAgent('POST', `/agent-work-items/${item.key}/comments`, {
      text: '@Shogo Dev 1 this is yours — round 2 on the same branch.',
    })
    expect(res.status).toBe(201)

    const row = await db.conversationMessage.findUnique({ where: { id: res.json.messageId } })
    expect(row.text).toBe('<@a:p:' + dev1 + '> this is yours — round 2 on the same branch.')
    const mentions = await mentionRows(row.id)
    expect(mentions.map((m: any) => ({ type: m.targetType, projectId: m.projectId })))
      .toEqual([{ type: 'agent', projectId: dev1 }])

    const wake = await waitFor(async () => invocations.find((i) => i.projectId === dev1))
    expect(wake.prompt).toContain('round 2 on the same branch.')
    expect(invocations.filter((i) => i.projectId === dev1)).toHaveLength(1)
  })

  test('the agent channel post route still tags a plain name now that the route no longer resolves it', async () => {
    agentAuth = { projectId: planner }
    const res = await asAgent('POST', '/agent-channels/dev/messages', { text: '@Shogo Dev 1 take the next card.' })
    expect(res.status).toBe(201)

    const row = await db.conversationMessage.findUnique({ where: { id: res.json.message.id } })
    expect(row.text).toBe(`<@a:p:${dev1}> take the next card.`)
    expect((await mentionRows(row.id)).map((m: any) => m.projectId)).toEqual([dev1])
    await waitFor(async () => invocations.find((i) => i.projectId === dev1))
  })

  test('a person’s card comment tags the person and notifies them', async () => {
    const item = await card('Ask a person')
    await addMember(seed.member)
    const res = await call(seed.owner, 'POST', `/work-items/${item.id}/comments`, {
      text: '@member can you check this one?',
    })
    expect(res.status).toBe(201)

    const row = await db.conversationMessage.findUnique({ where: { id: res.json.messageId } })
    expect(row.text).toBe(`<@u:${seed.member}> can you check this one?`)
    expect((await mentionRows(row.id)).map((m: any) => m.targetUserId)).toEqual([seed.member])
    await waitFor(async () => pushes.find((p) => p.userId === seed.member))
  })

  test('an approval post and an automation post are covered by the same insert point', async () => {
    // Both are ordinary inserts on a Shogo conversation: no route-level resolver involved.
    for (const authorType of ['agent', 'bot'] as const) {
      const result = await service.postMessage({
        conversationId: channelId,
        authorType,
        authorUserId: authorType === 'bot' ? seed.owner : null,
        authorAgentRef: authorType === 'agent' ? { projectId: planner, name: 'Shogo Planner' } : null,
        text: `@Shogo Dev 1 ${authorType} hand-off`,
      } as any)
      expect(result.row.text).toBe(`<@a:p:${dev1}> ${authorType} hand-off`)
      expect((await mentionRows(result.row.id)).map((m: any) => m.projectId)).toEqual([dev1])
    }
  })

  test('posting the same text twice creates one mention row per message, and a retried post adds none', async () => {
    const first = await service.postMessage({ conversationId: channelId, authorType: 'user', authorUserId: seed.owner, text: '@Shogo Dev 1 same text' })
    const retry = await service.postMessage({
      conversationId: channelId, authorType: 'user', authorUserId: seed.owner, text: '@Shogo Dev 1 same text', clientMsgId: 'retry-1',
    })
    const retryAgain = await service.postMessage({
      conversationId: channelId, authorType: 'user', authorUserId: seed.owner, text: '@Shogo Dev 1 same text', clientMsgId: 'retry-1',
    })
    expect((await mentionRows(first.row.id)).length).toBe(1)
    expect((await mentionRows(retry.row.id)).length).toBe(1)
    expect(retryAgain.duplicate).toBe(true)
    const rows = await db.conversationMessage.findMany({ where: { conversationId: channelId, clientMsgId: 'retry-1' } })
    expect(rows).toHaveLength(1)
  })

  test('a mirrored external conversation keeps the text it was given, with no mention and no wake', async () => {
    const external = await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'slack-import', kind: 'public' })
    await db.conversation.update({ where: { id: external.id }, data: { provider: 'slack', externalId: 'C123' } })
    const result = await service.postMessage({
      conversationId: external.id, authorType: 'user', authorUserId: seed.owner, text: '@Shogo Dev 1 this stays as written',
    } as any)
    expect(result.row.text).toBe('@Shogo Dev 1 this stays as written')
    expect(result.mentions).toEqual([])
    expect(await mentionRows(result.row.id)).toEqual([])
  })
})

describe('an ambiguous name is reported instead of silently dropped', () => {
  test('a card comment warns that @New Project matches several agents and tags none', async () => {
    const item = await card('Ambiguous tag')
    await addMember(seed.member)
    agentAuth = { projectId: planner }
    const res = await asAgent('POST', `/agent-work-items/${item.key}/comments`, { text: '@New Project please pick this up.' })
    expect(res.status).toBe(201)
    expect(res.json.mention_warnings).toEqual([
      '@New Project matches 2 people or agents — use the tag from team_directory',
    ])
    const row = await db.conversationMessage.findUnique({ where: { id: res.json.messageId } })
    expect(row.text).toBe('@New Project please pick this up.')
    expect(await mentionRows(row.id)).toEqual([])
  })

  test('a channel post reports the same warning and posts no mention', async () => {
    agentAuth = { projectId: planner }
    const res = await asAgent('POST', '/agent-channels/dev/messages', { text: '@New Project status?' })
    expect(res.status).toBe(201)
    expect(res.json.mention_warnings).toEqual([
      '@New Project matches 2 people or agents — use the tag from team_directory',
    ])
    expect(await mentionRows(res.json.message.id)).toEqual([])
  })
})
