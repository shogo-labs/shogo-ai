// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background tasks against a real SQLite database: creating and long-polling
 * tasks, the producers that settle them (a project call's record, a tagged
 * agent's reply, a card moving), and the wake: a settled, unseen task queues
 * one `task_notification` message that the chat queue dispatches to the
 * runtime, unless the agent already saw it or the session keeps waking itself.
 * Only the hop into the runtime is stubbed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const dispatched: any[] = []
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      dispatched.push(JSON.parse(await request.text()))
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
const { putAgentCall } = await import('../lib/agent-call-store')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { conversationRoutes } = await import('../routes/conversations')
const { agentBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api/internal', agentBoardRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') || undefined }),
}))
app.route('/api/internal', runtimeInternalRoutes({
  authenticate: async (c: any) => {
    const raw = c.req.header('x-identity')
    return raw ? JSON.parse(raw) : null
  },
  saveAgentAvatar: async () => ({}) as any,
  metalWorkspaceMember: (async () => null) as any,
} as any))
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const asProject = (projectId: string) => ({ 'x-identity': JSON.stringify({ kind: 'project', projectId }) })

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

afterEach(() => {
  tasks._testing.clearTimers()
  dispatched.length = 0
})

afterAll(async () => {
  tasks._testing.clearTimers()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('tasks', () => {
  test('create validates ids, sources and until patterns, and is idempotent', async () => {
    const chatSessionId = await newSession()
    const base = { chatSessionId, source: 'project_call', targetRef: 'p:run-1', title: 'analyst' }
    await expect(tasks.createTask({ ...base, id: 'nope' })).rejects.toThrow('Task ids')
    await expect(tasks.createTask({ ...base, id: 't_abcd1234', source: 'shell' })).rejects.toThrow('Unknown task source')
    await expect(tasks.createTask({ ...base, id: 't_abcd1234', until: '(' })).rejects.toThrow('valid regex')
    const first = await tasks.createTask({ ...base, id: 't_abcd1234' })
    const again = await tasks.createTask({ ...base, id: 't_abcd1234', title: 'other' })
    expect(again.title).toBe(first.title)
  })

  test('a long-poll returns as soon as the event settles the task', async () => {
    const chatSessionId = await newSession()
    const row = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'project_call', targetRef: 'proj-x:run-2', title: 'analyst' })
    const waiting = tasks.waitForTask(row.id, { waitMs: 5_000 })
    setTimeout(() => void tasks.emitTaskEvent('project_call', 'proj-x:run-2', { status: 'completed', line: 'Here is the report', summary: 'replied' }), 30)
    const started = Date.now()
    const outcome = await waiting
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(outcome!.row.status).toBe('completed')
    expect(outcome!.row.output).toBe('Here is the report')
    expect(tasks.viewOf(outcome!.row).result).toEqual({ summary: 'replied' })
  })

  test('a project call record settles its task, even when it finished first', async () => {
    const chatSessionId = await newSession()
    const live = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'project_call', targetRef: `${seed.projectId}:run-live`, title: 'live' })
    await putAgentCall(seed.projectId, { status: 'completed', runId: 'run-live', reply: 'done live', startedAt: Date.now(), updatedAt: Date.now() })
    expect((await tasks.getTask(live.id))!.status).toBe('completed')

    await putAgentCall(seed.projectId, { status: 'failed', runId: 'run-early', error: { message: 'model overloaded' }, startedAt: Date.now(), updatedAt: Date.now() })
    const late = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'project_call', targetRef: `${seed.projectId}:run-early`, title: 'late' })
    expect(late.status).toBe('failed')
    expect(late.output).toBe('model overloaded')
  })

  test('a tagged agent reply settles its reply task', async () => {
    const chatSessionId = await newSession()
    const [task] = await tasks.createReplyTasks(chatSessionId, 'msg-1', [{ projectId: seed.projectId, name: 'Billing Bot' }])
    expect(task!.title).toBe('@Billing Bot reply')
    await tasks.emitTaskEvent('agent_reply', tasks.replyTargetRef('msg-1', seed.projectId), tasks.replyEvent('done', 'Refund issued.'))
    const row = await tasks.getTask(task!.task_id)
    expect(row!.status).toBe('completed')
    expect(row!.output).toBe('Refund issued.')
    expect(tasks.replyEvent('error', null).status).toBe('failed')
  })

  test('a card task settles when a move matches the stored until, after the agent stopped waiting', async () => {
    const owner = { 'x-user': seed.member }
    const channel = await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'support' }, owner)
    expect(channel.status).toBe(201)
    const agent = (method: string, path: string, body?: unknown) =>
      call(method, `/internal/workspaces/${seed.workspaceId}${path}`, body, { 'x-project': seed.projectId })
    const board = await agent('POST', '/agent-boards', {
      channel: '#support', name: 'Intake',
      columns: [{ name: 'New', category: 'backlog' }, { name: 'Working', category: 'active' }, { name: 'Done', category: 'done' }],
    })
    const card = await agent('POST', `/agent-boards/${board.json.board.slug}/items`, { title: 'Password reset loop' })
    const itemId = card.json.item.id

    const chatSessionId = await newSession()
    const row = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'work_item', targetRef: itemId, title: card.json.item.key })
    const early = await tasks.waitForTask(row.id, { waitMs: 50, until: 'moved to Done' })
    expect(early!.matched).toBe(false)

    await agent('POST', `/agent-work-items/${card.json.item.key}/move`, { column: 'Working' })
    expect((await tasks.getTask(row.id))!.status).toBe('running')
    await agent('POST', `/agent-work-items/${card.json.item.key}/move`, { column: 'Done' })
    const settled = await waitFor(async () => {
      const r = await tasks.getTask(row.id)
      return r?.status === 'completed' ? r : null
    })
    expect(settled.output).toContain('moved to Working')
    expect(settled.output).toContain('moved to Done')
  })

  test('cancel stops tracking without waking anyone', async () => {
    const chatSessionId = await newSession()
    const row = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'agent_reply', targetRef: 'm:ws', title: '@Ops reply' })
    const cancelled = await tasks.cancelTask(row.id)
    expect(cancelled).toMatchObject({ status: 'cancelled', consumed: true })
    expect(await tasks.enqueueTaskWake(chatSessionId)).toBe(false)
  })
})

describe('wake', () => {
  test('an unseen finished task queues one task_notification that dispatches to the runtime', async () => {
    const chatSessionId = await newSession()
    const row = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'agent_reply', targetRef: 'msg-2:ws', title: '@Ops reply' })
    await tasks.emitTaskEvent('agent_reply', 'msg-2:ws', { status: 'completed', line: 'Deployed.' })
    tasks._testing.clearTimers()

    expect(await tasks.enqueueTaskWake(chatSessionId)).toBe(true)
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched).toHaveLength(1)
    const body = dispatched[0]
    expect(body.chatSessionId).toBe(chatSessionId)
    expect(body.userId).toBe(seed.owner)
    expect(body.taskNotification).toEqual({ taskIds: [row.id] })
    expect(body.text).toBe(`[Task update] @Ops reply (${row.id}) completed.\nLast output:\nDeployed.`)
    expect(body.messages[0].parts[1]).toEqual({ type: 'data-task-notification', data: { taskIds: [row.id] } })

    const userMessage = await db.chatMessage.findFirst({ where: { sessionId: chatSessionId, role: 'user' } })
    expect(userMessage.content).toBe(body.text)
    expect(await tasks.enqueueTaskWake(chatSessionId)).toBe(false)
  })

  test('the runtime hands over local tasks; its note is the message text', async () => {
    const chatSessionId = await newSession()
    const note = '[Task update] bun test (t_local001) failed (exit code 1).\nOutput: .shogo/tasks/s/t_local001.log'
    expect(await tasks.notifyLocalTasks(chatSessionId, [{ id: 't_local001', source: 'shell', title: 'bun test', status: 'failed', text: note }])).toBe(1)
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(chatSessionId)
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched[0].text).toBe(note)
  })

  test('a queued wake is dropped when the agent already saw every task in it', async () => {
    const chatSessionId = await newSession()
    const row = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'agent_reply', targetRef: 'msg-3:ws', title: '@Ops reply' })
    await tasks.emitTaskEvent('agent_reply', 'msg-3:ws', { status: 'completed' })
    tasks._testing.clearTimers()

    await db.chatSession.update({ where: { id: chatSessionId }, data: { activeTurnId: 'turn-1', activeTurnHeartbeatAt: new Date() } })
    await tasks.enqueueTaskWake(chatSessionId)
    expect(await db.chatQueuedMessage.count({ where: { sessionId: chatSessionId, kind: 'task_notification' } })).toBe(1)

    await tasks.consumeTasks([row.id])
    await db.chatSession.update({ where: { id: chatSessionId }, data: { activeTurnId: null, activeTurnHeartbeatAt: null } })
    await dispatchNext(chatSessionId)
    await waitFor(async () => (await db.chatQueuedMessage.count({ where: { sessionId: chatSessionId } })) === 0)
    expect(dispatched).toHaveLength(0)
  })

  test('after several wakes in a row the next one pauses until someone writes', async () => {
    const chatSessionId = await newSession()
    const wakeParts = JSON.stringify([{ type: 'text', text: '[Task update] x' }, { type: 'data-task-notification', data: { taskIds: ['t_old'] } }])
    for (let i = 0; i < tasks.MAX_CONSECUTIVE_WAKES; i++) {
      await db.chatMessage.create({ data: { sessionId: chatSessionId, role: 'user', content: '[Task update] x', parts: wakeParts, agent: 'technical', createdAt: new Date(Date.now() - (10 - i) * 1000) } })
    }
    await db.chatSession.update({ where: { id: chatSessionId }, data: { activeTurnId: 'turn-1', activeTurnHeartbeatAt: new Date() } })
    await tasks.createTask({ id: tasks.newTaskId(), chatSessionId, source: 'agent_reply', targetRef: 'msg-4:ws', title: '@Ops reply' })
    await tasks.emitTaskEvent('agent_reply', 'msg-4:ws', { status: 'completed' })
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(chatSessionId)
    await db.chatSession.update({ where: { id: chatSessionId }, data: { activeTurnId: null, activeTurnHeartbeatAt: null } })

    await dispatchNext(chatSessionId)
    const queued = await waitFor(async () => {
      const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: chatSessionId } })
      return row?.status === 'failed' ? row : null
    })
    expect(queued.error).toContain('Paused')
    expect(dispatched).toHaveLength(0)
  })
})

describe('internal routes', () => {
  test('a runtime creates, long-polls, consumes and cancels tasks of its own sessions only', async () => {
    const chatSessionId = await newSession()
    const id = tasks.newTaskId()
    const create = { id, chatSessionId, source: 'project_call', targetRef: 'other:run-9', title: 'analyst' }

    expect((await call('POST', '/internal/tasks', create, asProject(seed.foreignProjectId))).status).toBe(401)
    const created = await call('POST', '/internal/tasks', create, asProject(seed.projectId))
    expect(created.status).toBe(201)
    expect(created.json.task).toMatchObject({ id, status: 'running', result: null })

    expect((await call('GET', `/internal/tasks/${id}`, undefined, asProject(seed.foreignProjectId))).status).toBe(404)
    const listed = await call('GET', `/internal/tasks?chatSessionId=${chatSessionId}`, undefined, asProject(seed.projectId))
    expect(listed.json.tasks.map((t: any) => t.id)).toContain(id)

    setTimeout(() => void tasks.emitTaskEvent('project_call', 'other:run-9', { status: 'completed', line: 'ok' }), 30)
    const polled = await call('GET', `/internal/tasks/${id}?waitMs=5000`, undefined, asProject(seed.projectId))
    expect(polled.json.task).toMatchObject({ status: 'completed', output: 'ok' })

    const consumed = await call('POST', '/internal/tasks/consume', { ids: [id, 't_unknown1'] }, asProject(seed.projectId))
    expect(consumed.json.consumed).toBe(1)

    const other = await call('POST', '/internal/tasks', { ...create, id: tasks.newTaskId(), targetRef: 'other:run-10' }, asProject(seed.projectId))
    const cancelled = await call('POST', `/internal/tasks/${other.json.task.id}/cancel`, undefined, asProject(seed.projectId))
    expect(cancelled.json.task.status).toBe('cancelled')
  })

  test('notify queues a wake for local tasks', async () => {
    const chatSessionId = await newSession()
    const res = await call('POST', '/internal/tasks/notify', {
      chatSessionId,
      tasks: [{ id: 't_local002', source: 'subagent', title: 'explore', status: 'completed', text: '[Task update] explore (t_local002) completed.' }],
    }, asProject(seed.projectId))
    expect(res.json).toEqual({ queued: true })
    expect((await tasks.getTask('t_local002'))!.note).toContain('explore')
  })
})
