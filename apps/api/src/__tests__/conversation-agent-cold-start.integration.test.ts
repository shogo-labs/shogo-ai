// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A channel agent's runtime can answer 503 while it wakes. The dispatcher retries
 * only when the route marks the error retryable, tells the thread it is starting
 * up, and gives up once the wait budget is spent. Retries are not extra turns.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')
const { invalidateAgentReplyCapacity } = await import('../services/agent-reply-capacity')
const chatMessages = await import('../generated/chat-message.routes')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let reviewer: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
chatMessages.setPrisma(prisma as any)
app.route('/api/chat-messages', chatMessages.createChatMessageRoutes())

const events: Array<Record<string, any>> = []
let calls: string[] = []

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'x-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function jsonError(status: number, error: Record<string, unknown>) {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(text: string) {
  return sseResponse([
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'finish' },
  ])
}

const tag = (projectId: string) => `<@a:p:${projectId}>`

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  reviewer = (await db.project.create({ data: { name: 'Reviewer', workspaceId: seed.workspaceId } })).id
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => { events.push(envelope.event as any) })
})

beforeEach(() => {
  calls = []
  events.length = 0
  dispatcher._resetDispatcherForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function channel(name: string) {
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name,
    agents: [
      { projectId: builder, agentTrigger: 'mention' },
      { projectId: reviewer, agentTrigger: 'mention' },
    ],
    userEmails: [],
  })
  return ch.id as string
}

function script(responsesFor: (projectId: string | null, n: number) => Response, delays: number[], budget: number) {
  const seen = new Map<string, number>()
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: delays,
    retryBudgetMs: budget,
    invoke: async (args) => {
      const key = args.projectId ?? 'ws'
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      calls.push(key)
      return responsesFor(args.projectId, n)
    },
  })
}

async function settled(root: string, projectId: string) {
  return waitFor(async () => {
    const rows = await db.conversationMessage.findMany({
      where: { threadRootId: root, authorType: 'agent', agentStatus: { not: 'running' } },
    })
    return rows.find((r: any) => r.authorAgentRef?.projectId === projectId) ?? null
  })
}

describe('cold runtime retries', () => {
  test('two retryable 503s then a stream: one done reply, and the thread is told it is starting', async () => {
    const id = await channel('cold-ok')
    script((_project, n) => (
      n <= 2
        ? jsonError(503, { code: 'runtime_unreachable', message: 'Runtime unreachable — please retry.', retryable: true })
        : answer('Ran it.')
    ), [0, 0], 60_000)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} run it` })
    const reply = await settled(posted.json.message.id, builder)
    expect(reply.agentStatus).toBe('done')
    expect(reply.text).toBe('Ran it.')
    expect(calls.filter((id) => id === builder)).toHaveLength(3)
    const replies = await db.conversationMessage.findMany({ where: { threadRootId: posted.json.message.id, authorType: 'agent' } })
    expect(replies).toHaveLength(1)
    const saved = await db.chatMessage.findMany({ where: { sessionId: reply.agentSessionId, role: 'user' } })
    expect(saved).toHaveLength(1)
    const starting = events.filter((e) => e.type === 'agent.delta' && e.messageId === reply.id && e.text === 'Starting up…')
    expect(starting).toHaveLength(2)
  })

  test('retryable 503s past the budget settle as an error, once', async () => {
    const id = await channel('cold-give-up')
    script(() => jsonError(503, { code: 'pod_starting', message: 'Project runtime is starting up. Please retry in a few seconds.', retryable: true }), [10, 10, 10], 25)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} run it` })
    const reply = await settled(posted.json.message.id, builder)
    expect(reply.agentStatus).toBe('error')
    expect(reply.text).toContain('Project runtime is starting up. Please retry in a few seconds.')
    // 10 + 10 fits in 25; the third wait of 10 does not, so the third response is final.
    expect(calls).toHaveLength(3)
    const replies = await db.conversationMessage.findMany({ where: { threadRootId: posted.json.message.id, authorType: 'agent' } })
    expect(replies).toHaveLength(1)
  })

  test('a 503 that is not retryable is not retried', async () => {
    const id = await channel('cold-hard')
    script(() => jsonError(503, { code: 'pod_unavailable', message: 'Runtime refused the request.', retryable: false }), [0], 60_000)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} run it` })
    const reply = await settled(posted.json.message.id, builder)
    expect(reply.agentStatus).toBe('error')
    expect(reply.text).toContain('Runtime refused the request.')
    expect(calls).toHaveLength(1)
    expect(events.some((e) => e.text === 'Starting up…')).toBe(false)
  })

  test('a 500 is not retried', async () => {
    const id = await channel('cold-500')
    script(() => jsonError(500, { message: 'proxy failed' }), [0], 60_000)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} run it` })
    const reply = await settled(posted.json.message.id, builder)
    expect(reply.agentStatus).toBe('error')
    expect(reply.text).toContain('proxy failed')
    expect(calls).toHaveLength(1)
  })

  test('stopping during the backoff settles the reply and does not call the runtime again', async () => {
    const id = await channel('cold-stop')
    script(() => jsonError(503, { code: 'pod_starting', message: 'Project runtime is starting up.', retryable: true }), [2_000], 60_000)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} run it` })
    const root = posted.json.message.id as string
    const running = await waitFor(async () => {
      if (!calls.length) return null
      return db.conversationMessage.findFirst({ where: { threadRootId: root, agentStatus: 'running' } })
    })
    const stopped = await call(seed.member, 'POST', `/conversation-messages/${running.id}/stop`)
    expect(stopped.status).toBe(200)
    const reply = await settled(root, builder)
    expect(reply.agentStatus).toBe('stopped')
    expect(calls).toHaveLength(1)
  })

  test('a hand-off whose runtime is cold still runs once, and retries are not extra turns', async () => {
    const id = await channel('cold-chain')
    const cold = new Set<string>()
    script((project, n) => {
      if (project === builder) return answer(`Over to ${tag(reviewer)} for a look.`)
      if (n === 1) {
        cold.add(project ?? '')
        return jsonError(503, { code: 'runtime_unreachable', message: 'Runtime unreachable — please retry.', retryable: true })
      }
      return answer('Reviewed.')
    }, [0], 60_000)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} ship it` })
    const root = posted.json.message.id as string
    const review = await settled(root, reviewer)
    expect(review.agentStatus).toBe('done')
    expect(review.text).toBe('Reviewed.')
    const replies = await db.conversationMessage.findMany({
      where: { threadRootId: root, authorType: 'agent' },
      orderBy: { seq: 'asc' },
    })
    expect(replies.map((r: any) => r.authorAgentRef.projectId)).toEqual([builder, reviewer])
    expect(replies.map((r: any) => r.agentChain.depth)).toEqual([1, 2])
    expect(replies.map((r: any) => r.agentChain.turns)).toEqual([1, 2])
    expect(calls.filter((id) => id === builder)).toHaveLength(1)
    expect(calls.filter((id) => id === reviewer)).toHaveLength(2)
  })

  test('a workspace prompt retries a retryable 503 the same way', async () => {
    let n = 0
    dispatcher.configureConversationAgentDispatcher({
      retryDelaysMs: [0],
      retryBudgetMs: 60_000,
      invoke: async () => {
        n += 1
        return n === 1
          ? jsonError(503, { code: 'pod_starting', message: 'Project runtime is starting up.', retryable: true })
          : answer('Caught up.')
      },
    })
    const result = await dispatcher.runWorkspaceAgentPrompt({
      workspaceId: seed.workspaceId,
      userId: seed.member,
      prompt: 'catch me up',
      label: 'catch up',
    })
    expect(n).toBe(2)
    expect(result.failed).toBe(false)
    expect(result.text).toBe('Caught up.')
  })
})

describe('what the session stores for a dispatch', () => {
  const prompts: Array<{ projectId: string | null; sessionId: string; prompt: string }> = []
  let scripts: Record<string, string> = {}

  beforeEach(() => {
    prompts.length = 0
    scripts = {}
    dispatcher.configureConversationAgentDispatcher({
      invoke: async (args) => {
        prompts.push({ projectId: args.projectId, sessionId: args.sessionId, prompt: args.prompt })
        return answer(scripts[args.projectId ?? 'ws'] ?? 'ok')
      },
    })
  })

  async function userPrompt(sessionId: string, n = 1) {
    return waitFor(async () => {
      const rows = await db.chatMessage.findMany({ where: { sessionId, role: 'user' }, orderBy: { createdAt: 'asc' } })
      return rows.length >= n ? rows[n - 1] : null
    })
  }

  function readDispatch(row: { parts: string; content: string }) {
    const parts = JSON.parse(row.parts) as Array<{ type: string; text?: string; data?: any }>
    return {
      text: parts.find((p) => p.type === 'text')?.text,
      data: parts.find((p) => p.type === 'data-channel-dispatch')?.data,
      content: row.content,
    }
  }

  test('a channel mention records the channel, the thread and the message, and the model still gets the wrapper', async () => {
    const id = await channel('dispatch-mention')
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} run the check` })
    const reply = await settled(posted.json.message.id, builder)
    const row = await userPrompt(reply.agentSessionId)
    const saved = readDispatch(row)
    expect(saved.data).toMatchObject({
      conversationId: id,
      conversationName: 'dispatch-mention',
      threadRootId: posted.json.message.id,
      agentName: 'Builder',
      trigger: { authorName: 'member', text: '@Builder run the check' },
      contextMode: 'shared',
    })
    expect(saved.data.handedOffBy).toBeUndefined()
    expect(saved.text).toBe(saved.content)
    expect(saved.text).toBe(prompts.find((p) => p.sessionId === reply.agentSessionId)?.prompt)
    expect(saved.text).toContain('Team chat context:')

    const listed = await app.request(`/api/chat-messages/${row.id}`)
    expect(listed.status).toBe(200)
    const body = await listed.json()
    const parts = JSON.parse(body.data.parts)
    expect(parts.find((p: any) => p.type === 'data-channel-dispatch').data.threadRootId).toBe(posted.json.message.id)
  })

  test('a thread follow-up records the new message in the same thread', async () => {
    const id = await channel('dispatch-thread')
    const root = (await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} first` })).json.message.id as string
    const first = await settled(root, builder)
    await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: 'and also this', threadRootId: root })
    await waitFor(async () => {
      const rows = await db.chatMessage.findMany({ where: { sessionId: first.agentSessionId, role: 'user' } })
      return rows.length >= 2 ? true : null
    })
    const row = await userPrompt(first.agentSessionId, 2)
    const saved = readDispatch(row)
    expect(saved.data).toMatchObject({
      conversationId: id,
      threadRootId: root,
      trigger: { authorName: 'member', text: 'and also this' },
      contextMode: 'shared',
    })
    expect(saved.text).toBe(prompts.filter((p) => p.sessionId === first.agentSessionId)[1]?.prompt)
  })

  test('an agent direct message has no channel name and no thread', async () => {
    const opened = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/dms`, { agent: { projectId: builder } })
    expect(opened.status).toBe(200)
    const id = opened.json.conversation.id as string
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: 'hello there' })
    const reply = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({
        where: { conversationId: id, authorType: 'agent', agentStatus: 'done', id: { not: posted.json.message.id } },
      })
      return row ?? null
    })
    const saved = readDispatch(await userPrompt(reply.agentSessionId))
    expect(saved.data).toMatchObject({
      conversationId: id,
      conversationName: null,
      threadRootId: null,
      trigger: { authorName: 'member', text: 'hello there' },
      contextMode: 'shared',
    })
  })

  test('a hand-off names the agent that passed the work', async () => {
    const id = await channel('dispatch-handoff')
    scripts[builder] = `Over to ${tag(reviewer)} please.`
    const root = (await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} start` })).json.message.id as string
    const review = await settled(root, reviewer)
    const saved = readDispatch(await userPrompt(review.agentSessionId))
    expect(saved.data).toMatchObject({
      threadRootId: root,
      handedOffBy: 'Builder',
      trigger: { authorName: 'Builder', text: `Over to ${tag(reviewer)} please.`.replace(tag(reviewer), '@Reviewer') },
      contextMode: 'shared',
    })
    expect(saved.text).toContain('Builder (an agent) handed this to you.')
  })

  test('an isolated reviewer is marked isolated and is not given the discussion', async () => {
    const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
      name: 'dispatch-isolated',
      agents: [
        { projectId: builder, agentTrigger: 'mention' },
        { projectId: reviewer, agentTrigger: 'mention', agentContextMode: 'isolated' },
      ],
      userEmails: [],
    })
    scripts[builder] = `Ready for review. ${tag(reviewer)}`
    const root = (await call(seed.member, 'POST', `/conversations/${ch.id}/messages`, { text: `${tag(builder)} ship the widget` })).json.message.id as string
    const review = await settled(root, reviewer)
    const saved = readDispatch(await userPrompt(review.agentSessionId))
    expect(saved.data.contextMode).toBe('isolated')
    expect(saved.data.handedOffBy).toBe('Builder')
    expect(saved.text).toContain('independent reviewer')
    expect(saved.text).not.toContain('ship the widget')
    expect(saved.text).toBe(prompts.find((p) => p.projectId === reviewer)?.prompt)
  })
})

describe('opening the session before the run starts', () => {
  test('the prompt is already saved while the run waits for a free slot', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = 0
    dispatcher.configureConversationAgentDispatcher({
      invoke: async () => {
        started += 1
        await gate
        return answer('ok')
      },
    })
    // Pin the workspace to six slots: the local default is 24, so six tags would
    // not fill it and the seventh would start instead of waiting.
    await db.workspace.update({ where: { id: seed.workspaceId }, data: { agentReplyConcurrency: 6 } })
    invalidateAgentReplyCapacity(seed.workspaceId)
    const id = await channel('slot-wait')
    for (let i = 0; i < 6; i++) {
      await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} hold ${i}` })
    }
    await waitFor(async () => (started >= 6 ? true : null), 5000)
    const posted = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `${tag(builder)} the one that waits` })
    const root = posted.json.message.id as string
    const running = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'running' } })
      return row ?? null
    })
    try {
      const prompts = await waitFor(async () => {
        const rows = await db.chatMessage.findMany({ where: { sessionId: running.agentSessionId, role: 'user' } })
        return rows.length ? rows : null
      })
      // Still queued: the runtime has not been asked yet.
      expect(started).toBe(6)
      expect(prompts).toHaveLength(1)
      expect(JSON.parse(prompts[0].parts).some((p: any) => p.type === 'data-channel-dispatch')).toBe(true)
    } finally {
      release()
      await db.workspace.update({ where: { id: seed.workspaceId }, data: { agentReplyConcurrency: null } })
      invalidateAgentReplyCapacity(seed.workspaceId)
    }
    await settled(root, builder)
    await waitFor(async () => !(await db.conversationMessage.findFirst({ where: { agentStatus: 'running' } })))
  })
})
