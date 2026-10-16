// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace agent lists and stops agents running in team chat, for the
 * person who asked and only as far as that person could press Stop: a signed
 * requester is required, viewers cannot stop, channels they cannot see stay
 * hidden, and the agent never stops its own reply.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'running-agents-test-secret'

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')
const { startAgentReply } = await import('../services/chat-providers/outbound')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const tasks = await import('../services/background-tasks.service')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let reviewer: string
let invoked: string[] = []
let runtimeStops: Array<{ projectId: string | null; sessionId: string; userId: string }> = []

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  // `x-project` stands in for a project-scoped runtime token.
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') ?? null }),
}))

const ticketFor = (userId: string) => signRequesterTicket({ projectId: workspaceTicketKey(seed.workspaceId), userId })

async function asAgent(method: string, path: string, opts: { requester?: string; project?: string; body?: unknown } = {}) {
  const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels${path}`, {
    method,
    headers: {
      ...(opts.requester ? { 'X-Requester-Ticket': ticketFor(opts.requester) } : {}),
      ...(opts.project ? { 'x-project': opts.project } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function post(user: string, conversationId: string, text: string) {
  const res = await app.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'x-user': user, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return (await res.json() as any).message.id as string
}

/** A run that streams `text` and then works until it is stopped. */
function workUntilStopped(signal: AbortSignal, text: string): Response {
  const enc = new TextEncoder()
  const frame = (f: unknown) => enc.encode(`data: ${JSON.stringify(f)}\n\n`)
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(frame({ type: 'text-start', id: 't1' }))
      controller.enqueue(frame({ type: 'text-delta', id: 't1', delta: text }))
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

const tag = (projectId: string) => `<@a:p:${projectId}>`

async function channel(name: string, opts: { private?: boolean } = {}) {
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name,
    private: opts.private,
    agents: [
      { projectId: builder, agentTrigger: 'mention' },
      { projectId: reviewer, agentTrigger: 'mention' },
    ],
    userEmails: [],
  })
  return db.conversation.findUnique({ where: { id: ch.id } })
}

/** A running reply row with no live run behind it. */
async function placeholder(conversation: any, threadRootId: string | null, agentSessionId: string) {
  const handle = await startAgentReply({ conversation, agent: { projectId: builder, name: 'Builder' }, threadRootId, agentSessionId })
  return handle.messageId
}

async function runningIn(root: string) {
  return waitFor(async () => db.conversationMessage.findFirst({
    where: { threadRootId: root, authorType: 'agent', agentStatus: 'running', authorAgentRef: { not: null } },
  }))
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  reviewer = (await db.project.create({ data: { name: 'Reviewer', workspaceId: seed.workspaceId } })).id
})

beforeEach(() => {
  invoked = []
  runtimeStops = []
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    stopRuntimeTurn: async ({ projectId, sessionId, userId }) => { runtimeStops.push({ projectId, sessionId, userId }) },
    invoke: async (args) => {
      invoked.push(args.projectId ?? 'ws')
      return workUntilStopped(args.signal, args.projectId === builder ? `Handing to ${tag(reviewer)} now.` : 'Reviewing.')
    },
  })
})

afterAll(async () => {
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('who may list and stop agents', () => {
  test('a call with no signed requester is refused', async () => {
    const listed = await asAgent('GET', '/running-agents')
    expect(listed.status).toBe(403)
    expect(listed.json.error.code).toBe('requester_required')
    const stopped = await asAgent('POST', '/running-agents/stop', { body: { messageId: 'anything' } })
    expect(stopped.status).toBe(403)
    expect(stopped.json.error.code).toBe('requester_required')
  })

  test('a project agent cannot list or stop other agents, even with a requester', async () => {
    const listed = await asAgent('GET', '/running-agents', { requester: seed.member, project: builder })
    expect(listed.status).toBe(403)
    expect(listed.json.error.code).toBe('workspace_agent_only')
    const stopped = await asAgent('POST', '/running-agents/stop', { requester: seed.member, project: builder, body: { messageId: 'x' } })
    expect(stopped.status).toBe(403)
  })

  test('a viewer can see a run but not stop it', async () => {
    const ch = await channel('viewer-room')
    const root = await post(seed.member, ch.id, `${tag(builder)} build it`)
    const running = await runningIn(root)

    const listed = await asAgent('GET', `/running-agents?channel=viewer-room`, { requester: seed.viewer })
    expect(listed.status).toBe(200)
    expect(listed.json.runs.map((r: any) => [r.messageId, r.canStop])).toEqual([[running.id, false]])

    const byId = await asAgent('POST', '/running-agents/stop', { requester: seed.viewer, body: { messageId: running.id } })
    expect(byId.status).toBe(403)
    const byThread = await asAgent('POST', '/running-agents/stop', { requester: seed.viewer, body: { channel: 'viewer-room', threadRootId: root } })
    expect(byThread.status).toBe(403)
    expect((await db.conversationMessage.findUnique({ where: { id: running.id } })).agentStatus).toBe('running')

    await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: running.id } })
  })

  test('runs in a channel the requester cannot see are hidden and cannot be stopped', async () => {
    const secret = await channel('secret-room', { private: true })
    const id = await placeholder(secret, null, 'sess-secret')

    const listed = await asAgent('GET', '/running-agents', { requester: seed.member })
    expect(listed.json.runs.map((r: any) => r.messageId)).not.toContain(id)
    const named = await asAgent('GET', '/running-agents?channel=secret-room', { requester: seed.member })
    expect(named.status).toBe(404)
    const stopped = await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: id } })
    expect(stopped.status).toBe(404)
  })

  test('a message id from another workspace is not found', async () => {
    const otherChannel = await db.conversation.create({ data: { workspaceId: seed.otherWorkspaceId, kind: 'public', name: 'x', slug: 'x' } })
    const foreign = await placeholder(otherChannel, null, 'sess-foreign')
    const stopped = await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: foreign } })
    expect(stopped.status).toBe(404)
  })
})

describe('the Stop button', () => {
  test('stops the runtime turn, and work the agent handed off can no longer wake it', async () => {
    const ch = await channel('button-room')
    const root = await post(seed.member, ch.id, `${tag(builder)} go`)
    const running = await runningIn(root)
    const [watch] = await tasks.createReplyTasks(running.agentSessionId, root, [{ projectId: reviewer, name: 'Reviewer' }])

    const res = await app.request(`/api/conversation-messages/${running.id}/stop`, { method: 'POST', headers: { 'x-user': seed.member } })
    expect(res.status).toBe(200)
    await waitFor(async () => (await db.conversationMessage.findUnique({ where: { id: running.id } })).agentStatus === 'stopped')
    expect(runtimeStops).toEqual([{ projectId: builder, sessionId: running.agentSessionId, userId: seed.member }])
    expect((await db.backgroundTask.findUnique({ where: { id: watch.task_id } })).consumed).toBe(true)

    // The reviewer finishing later must not restart the stopped builder.
    await tasks.emitTaskEvent('agent_reply', `${root}:${reviewer}`, { status: 'completed', summary: 'replied' })
    expect((await db.backgroundTask.findUnique({ where: { id: watch.task_id } })).status).toBe('completed')
    expect(tasks._testing.wakeTimers.has(running.agentSessionId)).toBe(false)
    expect(await db.chatQueuedMessage.count({ where: { sessionId: running.agentSessionId } })).toBe(0)
  })
})

describe('stopping', () => {
  test('stopping a reply settles it as stopped, and the agent it tagged is never woken', async () => {
    const ch = await channel('loop-room')
    const root = await post(seed.member, ch.id, `${tag(builder)} start`)
    const running = await runningIn(root)
    await waitFor(async () => invoked.length > 0)
    await new Promise((r) => setTimeout(r, 50))

    const res = await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: running.id } })
    expect(res.status).toBe(200)
    expect(res.json.stopped.map((r: any) => [r.messageId, r.agent])).toEqual([[running.id, 'Builder']])

    const settled = await waitFor(async () => {
      const row = await db.conversationMessage.findUnique({ where: { id: running.id } })
      return row.agentStatus !== 'running' ? row : null
    })
    expect(settled.agentStatus).toBe('stopped')
    expect(settled.text).toContain(tag(reviewer))
    await new Promise((r) => setTimeout(r, 100))
    expect(invoked).toEqual([builder])
    expect(await db.conversationMessage.count({ where: { threadRootId: root, authorType: 'agent' } })).toBe(1)
  })

  test('the thread form stops every agent running there except the caller itself', async () => {
    const ch = await channel('thread-room')
    const root = await post(seed.member, ch.id, `${tag(builder)} go`)
    const running = await runningIn(root)
    const own = await placeholder(ch, root, 'sess-workspace-agent')

    const listed = await asAgent('GET', `/running-agents?channel=%23thread-room&threadRootId=${root}&sessionId=sess-workspace-agent`, { requester: seed.member })
    expect(listed.json.runs.map((r: any) => r.messageId)).toEqual([running.id])

    const res = await asAgent('POST', '/running-agents/stop', {
      requester: seed.member,
      body: { channel: '#thread-room', threadRootId: root, sessionId: 'sess-workspace-agent' },
    })
    expect(res.status).toBe(200)
    expect(res.json.stopped.map((r: any) => r.messageId)).toEqual([running.id])
    expect(res.json.skipped).toEqual([{ messageId: own, reason: 'self' }])
    await waitFor(async () => (await db.conversationMessage.findUnique({ where: { id: running.id } })).agentStatus === 'stopped')
    expect((await db.conversationMessage.findUnique({ where: { id: own } })).agentStatus).toBe('running')
  })

  test('a reply that already finished is skipped, not an error', async () => {
    const ch = await channel('done-room')
    const root = await post(seed.member, ch.id, `${tag(builder)} go`)
    const running = await runningIn(root)
    await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: running.id } })
    await waitFor(async () => (await db.conversationMessage.findUnique({ where: { id: running.id } })).agentStatus === 'stopped')

    const again = await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: running.id } })
    expect(again.status).toBe(200)
    expect(again.json).toEqual({ stopped: [], skipped: [{ messageId: running.id, reason: 'not_running' }] })
  })

  test('the agent stop also stops the runtime turn behind the reply', async () => {
    const ch = await channel('runtime-room')
    const root = await post(seed.member, ch.id, `${tag(builder)} go`)
    const running = await runningIn(root)
    await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { messageId: running.id } })
    expect(runtimeStops).toEqual([{ projectId: builder, sessionId: running.agentSessionId, userId: seed.member }])
  })

  test('neither a message id nor a thread is a bad request', async () => {
    const res = await asAgent('POST', '/running-agents/stop', { requester: seed.member, body: { channel: 'loop-room' } })
    expect(res.status).toBe(400)
  })
})
