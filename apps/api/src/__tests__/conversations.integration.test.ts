// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace channels against a real SQLite database: access rules, messages,
 * threads, reactions, DMs, realtime audience, @agent threads, agent tools,
 * and files.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const activity = await import('../services/conversation-activity')
const service = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace
let agentAuth: { projectId: string | null | undefined } = { projectId: null }
let invocations: Array<{ projectId: string | null; sessionId: string; prompt: string }> = []
let replyText = 'Here is the summary.'

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: agentAuth.projectId }),
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

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  invocations = []
  replyText = 'Here is the summary.'
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, sessionId: args.sessionId, prompt: args.prompt })
      return sseResponse([
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: replyText.slice(0, 5) },
        { type: 'text-delta', id: 't1', delta: replyText.slice(5) },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function general() {
  const { json } = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
  return json.conversations.find((c: any) => c.slug === 'general')
}

describe('conversations and access', () => {
  test('default channels are created and outsiders are rejected', async () => {
    const { status, json } = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    expect(status).toBe(200)
    const slugs = json.conversations.map((c: any) => c.slug)
    expect(slugs).toContain('general')
    expect(slugs).toContain('activity')
    expect((await call(seed.outsider, 'GET', `/workspaces/${seed.workspaceId}/conversations`)).status).toBe(403)
    expect((await call(null, 'GET', `/workspaces/${seed.workspaceId}/conversations`)).status).toBe(401)
  })

  test('everyone is in #general and cannot leave it', async () => {
    const { json } = await call(seed.viewer, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    const g = json.conversations.find((c: any) => c.slug === 'general')
    expect(g.joined).toBe(true)
    expect((await call(seed.viewer, 'POST', `/conversations/${g.id}/leave`)).status).toBe(400)
  })

  test('private channels are invisible until you are added', async () => {
    const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, {
      name: 'Leadership Team', kind: 'private',
    })
    expect(created.status).toBe(201)
    expect(created.json.conversation.slug).toBe('leadership-team')
    const id = created.json.conversation.id

    const memberList = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    expect(memberList.json.conversations.some((c: any) => c.id === id)).toBe(false)
    expect((await call(seed.member, 'GET', `/conversations/${id}`)).status).toBe(404)
    expect((await call(seed.member, 'POST', `/conversations/${id}/join`)).status).toBe(404)

    await call(seed.owner, 'POST', `/conversations/${id}/members`, { userIds: [seed.member, seed.outsider] })
    const after = await call(seed.member, 'GET', `/conversations/${id}`)
    expect(after.status).toBe(200)
    expect(after.json.conversation.members.map((m: any) => m.userId)).not.toContain(seed.outsider)
  })

  test('duplicate channel names get unique slugs and viewers cannot create channels', async () => {
    const a = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'design' })
    const b = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'Design' })
    expect(a.json.conversation.slug).toBe('design')
    expect(b.json.conversation.slug).toBe('design-2')
    expect((await call(seed.viewer, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'x' })).status).toBe(403)
  })

  test('#general cannot be archived; channel owners can archive their channels', async () => {
    const g = await general()
    expect((await call(seed.owner, 'PATCH', `/conversations/${g.id}`, { archived: true })).status).toBe(400)
    const ch = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'temp' })
    expect((await call(seed.member, 'PATCH', `/conversations/${ch.json.conversation.id}`, { archived: true })).status).toBe(200)
    const post = await call(seed.member, 'POST', `/conversations/${ch.json.conversation.id}/messages`, { text: 'hi' })
    expect(post.status).toBe(403)
  })
})

describe('messages', () => {
  test('posting assigns increasing seq, auto-joins public channels, and tracks unread', async () => {
    const g = await general()
    const m1 = await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: 'Hello team' })
    const m2 = await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: `Hi <@u:${seed.owner}>` })
    expect(m1.status).toBe(201)
    expect(m2.json.message.seq).toBe(m1.json.message.seq + 1)

    const ownerView = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.id === g.id)
    expect(ownerView.unreadCount).toBe(1)
    expect(ownerView.mentionCount).toBe(1)

    await call(seed.owner, 'POST', `/conversations/${g.id}/read`, {})
    const after = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.id === g.id)
    expect(after.unreadCount).toBe(0)
    expect(after.mentionCount).toBe(0)

    await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: 'thread only', threadRootId: m1.json.message.id })
    await call(seed.member, 'POST', `/conversations/${g.id}/messages`, {
      text: 'also here', threadRootId: m1.json.message.id, alsoSentToChannel: true,
    })
    const withReplies = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.id === g.id)
    expect(withReplies.unreadCount).toBe(1)
  })

  test('clientMsgId makes sends idempotent', async () => {
    const g = await general()
    const a = await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: 'once', clientMsgId: 'c-1' })
    const b = await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: 'once', clientMsgId: 'c-1' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.json.message.id).toBe(a.json.message.id)
  })

  test('threads count replies and "also send to channel" surfaces in the channel', async () => {
    const g = await general()
    const root = await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: 'Thread root' })
    const rootId = root.json.message.id
    await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: 'reply 1', threadRootId: rootId })
    const broadcast = await call(seed.member, 'POST', `/conversations/${g.id}/messages`, {
      text: 'reply 2', threadRootId: rootId, alsoSentToChannel: true,
    })
    const thread = await call(seed.owner, 'GET', `/conversations/${g.id}/messages?threadRootId=${rootId}`)
    expect(thread.json.root.replyCount).toBe(2)
    expect(thread.json.messages.map((m: any) => m.text)).toEqual(['reply 1', 'reply 2'])

    const channel = await call(seed.owner, 'GET', `/conversations/${g.id}/messages?limit=10`)
    const texts = channel.json.messages.map((m: any) => m.text)
    expect(texts).toContain('reply 2')
    expect(texts).not.toContain('reply 1')
    expect(channel.json.messages.at(-1).id).toBe(broadcast.json.message.id)
  })

  test('pagination and afterSeq backfill', async () => {
    const ch = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'paging' })
    const id = ch.json.conversation.id
    for (let i = 1; i <= 5; i++) await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: `m${i}` })
    const page = await call(seed.owner, 'GET', `/conversations/${id}/messages?limit=2`)
    expect(page.json.messages.map((m: any) => m.text)).toEqual(['m4', 'm5'])
    expect(page.json.hasMore).toBe(true)
    const older = await call(seed.owner, 'GET', `/conversations/${id}/messages?limit=2&beforeSeq=${page.json.messages[0].seq}`)
    expect(older.json.messages.map((m: any) => m.text)).toEqual(['m2', 'm3'])
    const newer = await call(seed.owner, 'GET', `/conversations/${id}/messages?afterSeq=3`)
    expect(newer.json.messages.map((m: any) => m.text)).toEqual(['m4', 'm5'])
  })

  test('only authors edit; admins can delete; viewers and #activity are read-only', async () => {
    const g = await general()
    const m = await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: 'typo' })
    const id = m.json.message.id
    expect((await call(seed.owner, 'PATCH', `/conversation-messages/${id}`, { text: 'hijack' })).status).toBe(403)
    const edited = await call(seed.member, 'PATCH', `/conversation-messages/${id}`, { text: 'fixed' })
    expect(edited.json.message.text).toBe('fixed')
    expect(edited.json.message.editedAt).not.toBeNull()
    const deleted = await call(seed.owner, 'DELETE', `/conversation-messages/${id}`)
    expect(deleted.json.message.deletedAt).not.toBeNull()
    expect(deleted.json.message.text).toBe('')

    expect((await call(seed.viewer, 'POST', `/conversations/${g.id}/messages`, { text: 'no' })).status).toBe(403)
    const activity = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.kind === 'activity')
    expect((await call(seed.owner, 'POST', `/conversations/${activity.id}/messages`, { text: 'no' })).status).toBe(403)
  })

  test('reactions toggle and aggregate', async () => {
    const g = await general()
    const m = await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: 'ship it?' })
    const id = m.json.message.id
    await call(seed.owner, 'POST', `/conversation-messages/${id}/reactions`, { emoji: '👍' })
    await call(seed.member, 'POST', `/conversation-messages/${id}/reactions`, { emoji: '👍' })
    await call(seed.member, 'POST', `/conversation-messages/${id}/reactions`, { emoji: '👍' })
    let r = await call(seed.member, 'POST', `/conversation-messages/${id}/reactions`, { emoji: '🎉' })
    expect(r.json.reactions).toEqual([
      { emoji: '👍', count: 2, userIds: [seed.owner, seed.member] },
      { emoji: '🎉', count: 1, userIds: [seed.member] },
    ])
    r = await call(seed.member, 'POST', `/conversation-messages/${id}/reactions`, { emoji: '🎉', on: false })
    expect(r.json.reactions.map((x: any) => x.emoji)).toEqual(['👍'])
    expect((await call(seed.viewer, 'POST', `/conversation-messages/${id}/reactions`, { emoji: '👍' })).status).toBe(403)
  })
})

describe('direct messages', () => {
  test('DMs are idempotent, private, and group DMs have a size limit', async () => {
    const a = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.member] })
    const b = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.owner] })
    expect(a.json.conversation.kind).toBe('dm')
    expect(b.json.conversation.id).toBe(a.json.conversation.id)
    expect((await call(seed.viewer, 'GET', `/conversations/${a.json.conversation.id}`)).status).toBe(404)

    const group = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.member, seed.viewer] })
    expect(group.json.conversation.kind).toBe('group_dm')
    expect((await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.outsider] })).status).toBe(400)

    const list = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    const dm = list.json.conversations.find((c: any) => c.id === a.json.conversation.id)
    expect(dm.participants.map((p: any) => p.id)).toEqual([seed.member])
  })
})

describe('realtime audience', () => {
  test('private conversation events only reach members; public events reach everyone', async () => {
    const received: any[] = []
    const unsubscribe = bus.subscribeWorkspaceEvents(seed.workspaceId, (env) => received.push(env))
    try {
      const priv = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'secret', kind: 'private' })
      await call(seed.owner, 'POST', `/conversations/${priv.json.conversation.id}/messages`, { text: 'hush' })
      const g = await general()
      await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: 'loud' })

      const hush = received.find((e) => e.event.type === 'message.created' && e.event.message.text === 'hush')
      const loud = received.find((e) => e.event.type === 'message.created' && e.event.message.text === 'loud')
      expect(bus.canReceive(hush, seed.owner)).toBe(true)
      expect(bus.canReceive(hush, seed.member)).toBe(false)
      expect(bus.canReceive(loud, seed.member)).toBe(true)
    } finally {
      unsubscribe()
    }
    expect(bus._conversationBusSubscribedWorkspaces()).not.toContain(seed.workspaceId)
  })
})

describe('@agent threads', () => {
  test('mentioning a project agent streams a reply into a thread backed by a project session', async () => {
    const g = await general()
    const updates: any[] = []
    const unsubscribe = bus.subscribeWorkspaceEvents(seed.workspaceId, (env) => {
      if (env.event.type === 'message.updated') updates.push(env.event.message)
    })
    const posted = await call(seed.member, 'POST', `/conversations/${g.id}/messages`, {
      text: `<@a:p:${seed.projectId}> summarize the invoices`,
    })
    const rootId = posted.json.message.id
    const reply = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({ where: { threadRootId: rootId, authorType: 'agent' } })
      return row?.agentStatus === 'done' ? row : null
    })
    unsubscribe()
    expect(reply.text).toBe('Here is the summary.')
    expect(reply.authorAgentRef).toEqual({ projectId: seed.projectId, name: 'Billing Bot' })
    const session = await db.chatSession.findUnique({ where: { id: reply.agentSessionId } })
    expect(session.contextType).toBe('project')
    expect(session.contextId).toBe(seed.projectId)
    expect(invocations[0].prompt).toContain('summarize the invoices')
    expect(invocations[0].prompt).toContain('#general')
    const final = updates.find((m) => m.id === reply.id && m.agentStatus === 'done')
    expect(final.text).toBe('Here is the summary.')

    replyText = 'Follow-up answer.'
    await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: 'and last month?', threadRootId: rootId })
    await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { threadRootId: rootId, authorType: 'agent' } })
      return rows.find((r: any) => r.text === 'Follow-up answer.' && r.agentStatus === 'done')
    })
    expect(invocations).toHaveLength(2)
    expect(invocations[1].sessionId).toBe(invocations[0].sessionId)
    expect(invocations[1].prompt).toContain('and last month?')
    expect(invocations[1].prompt).not.toContain('summarize the invoices')
  })

  test('the workspace agent gets a workspace session; agent DMs reply without an @mention', async () => {
    const dm = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { agent: { projectId: null } })
    expect(dm.json.conversation.kind).toBe('dm')
    await call(seed.owner, 'POST', `/conversations/${dm.json.conversation.id}/messages`, { text: 'what is on my plate?' })
    const reply = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({
        where: { conversationId: dm.json.conversation.id, authorType: 'agent', agentStatus: 'done' },
      })
      return row
    })
    expect(reply.threadRootId).toBeNull()
    const session = await db.chatSession.findUnique({ where: { id: reply.agentSessionId } })
    expect(session.contextType).toBe('workspace')
    expect(session.workspaceId).toBe(seed.workspaceId)
    expect(invocations[0].projectId).toBeNull()

    const listed = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.id === dm.json.conversation.id)
    expect(listed.participants).toEqual([{ type: 'agent', projectId: null, name: 'Shogo' }])
  })

  test('agent members with keyword triggers reply to matching top-level messages only', async () => {
    const ch = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'support' })
    const id = ch.json.conversation.id
    await call(seed.owner, 'POST', `/conversations/${id}/agents`, { projectId: seed.projectId, trigger: 'keyword', keywords: 'refund, invoice' })
    await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: 'lunch plans?' })
    await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: 'Customer wants a REFUND' })
    await waitFor(async () => db.conversationMessage.findFirst({ where: { conversationId: id, authorType: 'agent', agentStatus: 'done' } }))
    expect(invocations).toHaveLength(1)
    expect(invocations[0].prompt).toContain('REFUND')
  })

  test('failed agent runs are reported on the reply', async () => {
    dispatcher.configureConversationAgentDispatcher({
      invoke: async () => new Response(JSON.stringify({ error: { message: 'runtime offline' } }), { status: 503 }),
    })
    const g = await general()
    const posted = await call(seed.owner, 'POST', `/conversations/${g.id}/messages`, { text: '<@a:ws> ping' })
    const reply = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({ where: { threadRootId: posted.json.message.id, authorType: 'agent' } })
      return row?.agentStatus === 'error' ? row : null
    })
    expect(reply.text).toContain('runtime offline')
  })

  test('mentions of agents outside the workspace are rejected when adding members', async () => {
    const g = await general()
    const res = await call(seed.owner, 'POST', `/conversations/${g.id}/agents`, { projectId: seed.foreignProjectId })
    expect(res.status).toBe(400)
  })
})

describe('agent channel tools', () => {
  test('agents post as themselves, DM teammates, read, and search', async () => {
    agentAuth = { projectId: seed.projectId }
    const post = await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/general/messages`, {
      text: `Invoices reconciled for <@u:${seed.member}>`,
    })
    expect(post.status).toBe(201)
    const row = await db.conversationMessage.findUnique({ where: { id: post.json.message.id } })
    expect(row.authorType).toBe('agent')
    expect(row.authorAgentRef.projectId).toBe(seed.projectId)
    expect(invocations).toHaveLength(0)

    const read = await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels/general/messages?limit=5`)
    const last = read.json.messages.at(-1)
    expect(last.text).toContain('Invoices reconciled for @member')
    expect(last.author).toBe('Billing Bot (agent)')

    const search = await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels/search?q=reconciled`)
    expect(search.json.results[0].channel).toBe('general')

    const member = await db.user.findUnique({ where: { id: seed.member } })
    const dm = await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/dm`, {
      user: member.email, text: 'Can you approve the refund?',
    })
    expect(dm.status).toBe(201)
    const convo = await call(seed.member, 'GET', `/conversations/${dm.json.message.conversationId}`)
    expect(convo.status).toBe(200)
    expect(convo.json.conversation.members.some((m: any) => m.type === 'agent' && m.projectId === seed.projectId)).toBe(true)

    const priv = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'hidden', kind: 'private' })
    const blocked = await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels/${priv.json.conversation.id}/messages`)
    expect(blocked.status).toBe(404)
    agentAuth = { projectId: null }
  })
})

describe('#activity and agent results', () => {
  async function activityTexts() {
    const activity = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.kind === 'activity')
    const res = await call(seed.member, 'GET', `/conversations/${activity.id}/messages?limit=50`)
    return res.json.messages as any[]
  }

  test('task outcomes post once to #activity and deliver the result to the chosen channel', async () => {
    const ch = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'finance' })
    const task = {
      id: crypto.randomUUID(), workspaceId: seed.workspaceId, userId: seed.owner, title: 'Reconcile invoices',
      projectId: seed.projectId, chatSessionId: 'sess-1', notifyConversationId: ch.json.conversation.id,
      resultSummary: '3 invoices overdue', errorMessage: null, status: 'completed',
    }
    await activity.recordAgentTaskOutcome(task)
    await activity.recordAgentTaskOutcome(task)

    const lines = (await activityTexts()).filter((m) => m.blocks?.taskId === task.id)
    expect(lines).toHaveLength(1)
    expect(lines[0].authorType).toBe('system')
    expect(lines[0].text).toContain('**Billing Bot** finished the task “Reconcile invoices”')
    expect(lines[0].blocks.kind).toBe('task.completed')

    const delivered = await call(seed.owner, 'GET', `/conversations/${ch.json.conversation.id}/messages`)
    expect(delivered.json.messages).toHaveLength(1)
    expect(delivered.json.messages[0].authorType).toBe('agent')
    expect(delivered.json.messages[0].text).toContain('3 invoices overdue')
    expect(invocations).toHaveLength(0)
  })

  test('people discuss #activity items in threads but cannot post at the top level', async () => {
    const [item] = await activityTexts()
    const activityId = item.conversationId
    const detail = await call(seed.member, 'GET', `/conversations/${activityId}`)
    expect(detail.json.conversation.canPost).toBe(false)
    expect(detail.json.conversation.canReply).toBe(true)

    const reply = await call(seed.member, 'POST', `/conversations/${activityId}/messages`, {
      text: 'Looking into it', threadRootId: item.id, alsoSentToChannel: true,
    })
    expect(reply.status).toBe(201)
    expect(reply.json.message.alsoSentToChannel).toBe(false)
    const top = await activityTexts()
    expect(top.some((m) => m.id === reply.json.message.id)).toBe(false)
    expect(top.find((m) => m.id === item.id).replyCount).toBe(1)
    expect((await call(seed.viewer, 'POST', `/conversations/${activityId}/messages`, { text: 'x', threadRootId: item.id })).status).toBe(403)
  })

  test('schedule failures, goal events, publishes and joins show up in #activity', async () => {
    await activity.recordScheduleOutcome(
      { id: 'sch-1', workspaceId: seed.workspaceId, userId: seed.owner, name: 'Daily digest' },
      { status: 'failed', error: 'runtime offline', runKey: '2026-09-30T08:00:00.000Z' },
    )
    const goal = await db.goal.create({ data: { workspaceId: seed.workspaceId, title: 'Launch v2' } })
    await activity.recordGoalEvent(seed.workspaceId, { id: 'ge-1', goalId: goal.id, kind: 'blocker', message: 'Waiting on legal' })
    await activity.recordGoalEvent(seed.workspaceId, { id: 'ge-2', goalId: goal.id, kind: 'note', message: 'ignored' })
    await activity.recordProjectPublished({ id: seed.projectId, workspaceId: seed.workspaceId, name: 'Billing Bot' }, 'https://billing.shogo.one', new Date(1))
    await activity.recordMemberJoined(seed.workspaceId, seed.viewer)

    const texts = (await activityTexts()).map((m) => m.text)
    expect(texts.some((t) => t.includes('scheduled run “Daily digest” failed: runtime offline'))).toBe(true)
    expect(texts.some((t) => t.includes('is blocked on the goal “Launch v2”: Waiting on legal'))).toBe(true)
    expect(texts.some((t) => t.includes('ignored'))).toBe(false)
    expect(texts.some((t) => t.includes('was published to https://billing.shogo.one'))).toBe(true)
    expect(texts.some((t) => t.includes('**viewer** joined the workspace'))).toBe(true)
  })

  test('notify conversations must be postable conversations the user can read', async () => {
    const priv = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'ops-private', kind: 'private' })
    const activityConv = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`))
      .json.conversations.find((c: any) => c.kind === 'activity')
    expect(await service.resolveNotifyConversation(seed.workspaceId, '#general', seed.member)).toBe((await general()).id)
    expect(await service.resolveNotifyConversation(seed.workspaceId, priv.json.conversation.id, seed.owner)).toBe(priv.json.conversation.id)
    expect(await service.resolveNotifyConversation(seed.workspaceId, null, seed.member)).toBeNull()
    expect(await service.resolveNotifyConversation(seed.workspaceId, undefined, seed.member)).toBeUndefined()
    await expect(service.resolveNotifyConversation(seed.workspaceId, priv.json.conversation.id, seed.member)).rejects.toThrow()
    await expect(service.resolveNotifyConversation(seed.workspaceId, activityConv.id, seed.owner)).rejects.toThrow()
    await expect(service.resolveNotifyConversation(seed.otherWorkspaceId, (await general()).id, seed.outsider)).rejects.toThrow()
  })

  test('catch me up summarizes unread messages with the workspace agent', async () => {
    const ch = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'launch' })
    const id = ch.json.conversation.id
    await call(seed.member, 'POST', `/conversations/${id}/join`)
    await call(seed.member, 'POST', `/conversations/${id}/read`, {})
    const empty = await call(seed.member, 'POST', `/conversations/${id}/catch-up`)
    expect(empty.json).toMatchObject({ summary: null, messageCount: 0 })

    await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: 'We ship Friday' })
    await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: `<@u:${seed.member}> can you write the changelog?` })
    replyText = '- Ship Friday\n- You own the changelog'
    const res = await call(seed.member, 'POST', `/conversations/${id}/catch-up`)
    expect(res.status).toBe(200)
    expect(res.json.summary).toBe('- Ship Friday\n- You own the changelog')
    expect(res.json.messageCount).toBe(2)
    expect(invocations[0].projectId).toBeNull()
    expect(invocations[0].prompt).toContain('owner: @member can you write the changelog?')
  })
})

describe('files', () => {
  test('upload, attach to a message, and download with the capability token', async () => {
    const g = await general()
    const form = new FormData()
    form.append('file', new File([new TextEncoder().encode('hello file')], 'notes.txt', { type: 'text/plain' }))
    const up = await app.request(`/api/conversations/${g.id}/attachments`, {
      method: 'POST', headers: { 'x-user': seed.member }, body: form,
    })
    expect(up.status).toBe(201)
    const { attachment } = await up.json()
    const msg = await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: '', attachmentIds: [attachment.id] })
    expect(msg.json.message.attachments[0].name).toBe('notes.txt')

    const ok = await app.request(attachment.url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('hello file')
    const forged = await app.request(`/api/conversation-files/${attachment.id}?t=nope`)
    expect(forged.status).toBe(403)
  })
})
