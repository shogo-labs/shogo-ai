// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-88 acceptance, against a real SQLite database and the real routes.
 *
 * Two halves, both driven the way production drives them:
 *
 * 1. A hand-off watch lasts the card's whole life. The watch is created through
 *    the internal task route (what the runtime's board tools call), the card is
 *    moved through the agent move route (what `work_item_move` calls), and the
 *    wake is left to the real coalesce timer + dispatcher — nothing here calls
 *    `enqueueTaskWake` by hand, because the re-arm lives on that path.
 * 2. A paused session's waiting updates are readable from the session (the
 *    internal tasks route), and the composer's Resume action delivers them
 *    through `POST /api/chat-queued-messages/:id/resume` without a person
 *    typing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

/** The hop into the runtime is the only thing stubbed. */
const dispatched: any[] = []
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
// Keep the module's other exports: `workspace-chat` imports from it statically,
// and a partial mock fails at module load rather than at a request.
const realProjectChat = await import('../routes/project-chat')
mock.module('../routes/project-chat', () => ({
  ...realProjectChat,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      dispatched.push(JSON.parse(await request.text()))
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { conversationRoutes } = await import('../routes/conversations')
const { agentBoardRoutes } = await import('../routes/work-boards')
const { chatQueuedMessageActionsRoutes } = await import('../routes/chat-queued-message-actions')
const bus = await import('../lib/conversation-bus')

const db = prisma as any
let seed: SeededWorkspace

/**
 * `tunnelAuthenticated` stands in for the session-access hop the composer has
 * already passed; everything below it is the route's real logic.
 */
const app = new Hono<{ Variables: { auth: any } }>()
app.use('*', async (c, next) => {
  c.set('auth', { userId: seed.owner, tunnelAuthenticated: true })
  await next()
})
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
app.route('/api/chat-queued-messages', chatQueuedMessageActionsRoutes())

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const asProject = (projectId: string) => ({ 'x-identity': JSON.stringify({ kind: 'project', projectId }) })

/** The pattern the runtime hands the API when it opens a hand-off watch. */
const HANDOFF_UNTIL = 'moved to [^\\n]*\\((review|waiting|done|dismissed)\\)|(^|\\n)agent (stopped|failed)'

async function pastWake(chatSessionId: string, index: number): Promise<string> {
  const id = tasks.newTaskId()
  await db.backgroundTask.create({
    data: {
      id, chatSessionId, source: 'agent_reply', targetRef: `old-${index}`, title: `@Ops reply ${index}`,
      status: 'completed', consumed: true, finishedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    },
  })
  const parts = JSON.stringify([{ type: 'text', text: '[Task update] x' }, { type: 'data-task-notification', data: { taskIds: [id] } }])
  await db.chatMessage.create({ data: { sessionId: chatSessionId, role: 'user', content: '[Task update] x', parts, agent: 'technical' } })
  return id
}

let n = 0

/**
 * A board shaped like lacvapps' — the QA lane is `review` and binds an agent,
 * which is the case that used to open no watch at all.
 */
async function watchedCard() {
  const name = `sho88-${++n}`
  await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name }, { 'x-user': seed.member })
  const agent = (method: string, path: string, body?: unknown) =>
    call(method, `/internal/workspaces/${seed.workspaceId}${path}`, body, { 'x-project': seed.projectId })
  const board = await agent('POST', '/agent-boards', {
    channel: `#${name}`,
    name,
    columns: [
      { name: 'In progress', category: 'active' },
      { name: 'QA', category: 'review', agent: `project:${seed.projectId}` },
      { name: 'Review', category: 'review' },
      { name: 'Changes Requested', category: 'active' },
      { name: 'Done', category: 'done' },
    ],
  })
  const card = await agent('POST', `/agent-boards/${board.json.board.slug}/items`, {
    title: 'Sim kernel',
    assignee_agent: `project:${seed.projectId}`,
  })
  const item = await db.workItem.findUnique({ where: { id: card.json.item.id } })
  // The session that handed the card off — it owns the watch.
  const session = await db.chatSession.create({
    data: { inferredName: 'QA lane', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  const watchId = tasks.newTaskId()
  const created = await call('POST', '/internal/tasks', {
    id: watchId,
    chatSessionId: session.id,
    source: 'work_item',
    targetRef: item.id,
    title: card.json.item.key,
    until: HANDOFF_UNTIL,
  }, asProject(seed.projectId))
  expect(created.status).toBe(201)
  const row = (await tasks.getTask(watchId))!
  const move = (column: string) => agent('POST', `/agent-work-items/${card.json.item.key}/move`, { column })
  return { item, session, watchId, createdAt: row.createdAt.getTime(), move }
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

describe('SHO-88 · one watch follows the card from lane to Done', () => {
  test('every milestone wakes the assigner, and between them exactly one watch row is live', async () => {
    const c = await watchedCard()
    const live = async () => (await tasks.getTask(c.watchId))!
    /** The wakes the API actually dispatched for this card. */
    const wakes = () => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(c.watchId))
    /** A milestone landed, reached the runtime, and the watch is watching again. */
    const milestone = async (count: number, column: string) => {
      await waitFor(async () => wakes().length >= count && (await tasks.getTask(c.watchId))!.status === 'running', 10_000)
      expect(wakes()[count - 1].text).toContain(`moved to ${column} (review)`)
      const row = await live()
      // Same row, same life: one task id and one createdAt for the whole card.
      expect(row.id).toBe(c.watchId)
      expect(row.createdAt.getTime()).toBe(c.createdAt)
      // The agent was handed the update (the dispatcher consumed it) and the
      // watch is still live, so the next milestone is news rather than silent.
      expect(row.consumed).toBe(false)
      expect(row.notifiedAt).toBeNull()
      expect(row.status).toBe('running')
    }

    expect((await live()).status).toBe('running')

    // lane → QA: a review-category column that binds an agent.
    await c.move('QA')
    await milestone(1, 'QA')

    // QA → Review: the hand-off that used to end the watch.
    await c.move('Review')
    await milestone(2, 'Review')

    // The bounce. "Changes Requested" is `active`, so it is not a wake point —
    // what matters is that going back does not kill the watch.
    await c.move('Changes Requested')
    await new Promise((r) => setTimeout(r, 250))
    expect((await live()).status).toBe('running')
    expect(wakes()).toHaveLength(2)

    await c.move('QA')
    await milestone(3, 'QA')

    // Done: terminal, settled for good.
    await c.move('Done')
    await waitFor(() => (wakes()[3] ?? null), 10_000)
    const closed = await live()
    expect(closed.status).toBe('completed')
    expect(closed.summary).toBe('the card is closed')
    // …and it does not come back to life on the next drain.
    await new Promise((r) => setTimeout(r, 2_500))
    expect((await live()).status).toBe('completed')
    expect(wakes()).toHaveLength(4)

    // One row for the card's whole life, never a successor per column.
    expect(await db.backgroundTask.count({ where: { chatSessionId: c.session.id, source: 'work_item' } })).toBe(1)
  }, 60_000)

  test('a watch past its expiry stops instead of re-arming', async () => {
    const c = await watchedCard()
    await db.backgroundTask.update({ where: { id: c.watchId }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    await c.move('QA')
    await waitFor(async () => (dispatched.some((body) => (body.taskNotification?.taskIds ?? []).includes(c.watchId)) ? true : null), 10_000)
    // The last update still gets through; the watch just does not carry on.
    await new Promise((r) => setTimeout(r, 500))
    const row = (await tasks.getTask(c.watchId))!
    expect(row.status).toBe('completed')
    expect(row.notifiedAt).toBeTruthy()
  }, 30_000)

  test('two moves back to back land as one wake that ends the watch on the real state', async () => {
    // QA round 1: a milestone arriving while the previous wake is still in flight
    // used to be dropped — QA → Done inside the coalesce window told the watcher
    // "QA" and never that the card had finished.
    const c = await watchedCard()
    const wakes = () => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(c.watchId))

    await c.move('QA')
    await c.move('Done')

    await waitFor(() => (wakes().length ? true : null), 10_000)
    // Nothing else arrives: the two moves are one story for the agent.
    await new Promise((r) => setTimeout(r, 2_500))
    expect(wakes()).toHaveLength(1)
    // …and it is the story that ends with the card closed, not the one that
    // stopped at QA.
    expect(wakes()[0].text).toContain('moved to Done (done)')

    const settled = (await tasks.getTask(c.watchId))!
    expect(settled.status).toBe('completed')
    expect(settled.summary).toBe('the card is closed')
    expect(settled.notifiedAt).toBeTruthy()
    // Settled for good: a later drain does not revive it and adds no wake.
    await tasks.enqueueTaskWake(c.session.id)
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    expect(wakes()).toHaveLength(1)
  }, 30_000)

  test('two review moves inside one window reach the agent as one note, and the watch survives', async () => {
    // The same window, a non-terminal second move: both lines belong to one
    // note, and because the card is still open the watch must come back.
    const c = await watchedCard()
    const wakes = () => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(c.watchId))

    await c.move('QA')
    await c.move('Review')
    await waitFor(() => (wakes().length ? true : null), 10_000)
    await new Promise((r) => setTimeout(r, 2_500))
    expect(wakes()).toHaveLength(1)
    expect(wakes()[0].text).toContain('moved to QA (review)')
    expect(wakes()[0].text).toContain('moved to Review (review)')
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')

    // …and the card is still watched afterwards.
    await c.move('Done')
    await waitFor(() => (wakes().length >= 2 ? true : null), 10_000)
    expect(wakes()[1].text).toContain('moved to Done (done)')
    expect((await tasks.getTask(c.watchId))!.summary).toBe('the card is closed')
  }, 30_000)

  test('archiving a watched card ends the watch instead of leaving it to expire', async () => {
    const c = await watchedCard()
    const archived = await call(
      'POST',
      `/internal/workspaces/${seed.workspaceId}/agent-work-items/${c.item.key}/archive`,
      { archived: true },
      { 'x-project': seed.projectId },
    )
    expect(archived.status).toBe(200)
    const row = (await tasks.getTask(c.watchId))!
    expect(row.status).toBe('completed')
    expect(row.summary).toBe('the card is closed')
  }, 30_000)
})

describe('SHO-88 · a paused session is visible to the agent and to the person', () => {
  /** Drive a session into the wake pause the way the dispatcher does. */
  async function pausedSession(): Promise<{ sessionId: string; taskId: string }> {
    const session = await db.chatSession.create({
      data: { inferredName: 'Paused', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
    })
    for (let i = 0; i < tasks.MAX_CONSECUTIVE_WAKES; i++) {
      await pastWake(session.id, i)
      await new Promise((r) => setTimeout(r, 20))
    }
    await db.chatSession.update({ where: { id: session.id }, data: { activeTurnId: 'turn-1', activeTurnHeartbeatAt: new Date() } })
    const task = await tasks.createTask({
      id: tasks.newTaskId(), chatSessionId: session.id, source: 'agent_reply', targetRef: 'ops:waiting', title: '@Ops reply',
    })
    await tasks.emitTaskEvent('agent_reply', 'ops:waiting', { status: 'completed' })
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session.id)
    await db.chatSession.update({ where: { id: session.id }, data: { activeTurnId: null, activeTurnHeartbeatAt: null } })
    const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
    await dispatchNext(session.id)
    await waitFor(() => db.chatQueuedMessage.findFirst({ where: { sessionId: session.id, status: 'failed' } }), 5_000)
    return { sessionId: session.id, taskId: task.id }
  }

  test('the session route reports the pause and the titles behind it', async () => {
    const { sessionId, taskId } = await pausedSession()
    const listed = await call('GET', `/internal/tasks?chatSessionId=${sessionId}`, undefined, asProject(seed.projectId))
    expect(listed.status).toBe(200)
    expect(listed.json.wake).toMatchObject({ paused: true })
    expect(listed.json.wake.wakesInARow).toBeGreaterThanOrEqual(listed.json.wake.limit)
    expect(listed.json.wake.waiting).toContainEqual(
      expect.objectContaining({ taskId, source: 'agent_reply', title: '@Ops reply' }),
    )
  }, 30_000)

  test('Resume delivers the waiting updates without a person writing', async () => {
    const { sessionId, taskId } = await pausedSession()
    const paused = await db.chatQueuedMessage.findFirst({ where: { sessionId, status: 'failed' } })
    expect(paused.error).toContain('Paused')
    expect(tasks.taskWakeIdsFromBody(paused.body)).toEqual([taskId])

    const resumed = await call('POST', `/chat-queued-messages/${paused.id}/resume`)
    expect(resumed.status).toBe(200)
    expect(resumed.json.data.status).toBe('pending')
    expect(resumed.json.data.error).toBeNull()
    expect(JSON.parse(resumed.json.data.body).taskNotification).toMatchObject({ wakeRunReset: true, paused: false })

    // It runs instead of pausing again, and the pause is over afterwards.
    await waitFor(async () => (dispatched.length > 0 ? true : null), 10_000)
    expect(dispatched[0].taskNotification).toMatchObject({ taskIds: [taskId], wakeRunReset: true })
    const state = await tasks.sessionWakeState(sessionId)
    expect(state.paused).toBe(false)
    expect(state.waiting).toHaveLength(0)
  }, 30_000)
})
