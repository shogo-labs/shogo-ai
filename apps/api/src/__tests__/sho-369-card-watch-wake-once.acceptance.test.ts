// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-369 acceptance, against a real SQLite database and the real routes.
 *
 * The bug (2026-11-27/28, Russell): one card's `[Task update]` reached the
 * watching chat 217 times, and 208 of those arrived in a single turn. Three
 * defects stacked:
 *
 * 1. `enqueueTaskWake` re-armed the card watch as soon as it queued the wake, so
 *    the next card event settled the row again and queued a second row for the
 *    same task — and `consumeTasks` skips running `work_item` rows, so no copy
 *    was ever dropped as "already seen".
 * 2. Nothing kept one pending wake per task, so the copies stacked in the queue.
 * 3. `until` was tested against the accumulated output, so a comment quoting
 *    "moved to QA (review)" settled a watch.
 *
 * Each block below is one acceptance criterion from the card, driven the way
 * production drives it: the internal task route creates the watch, the agent
 * board routes move the card, the run-end seam records stops, and the real
 * coalesce timer + dispatcher deliver.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

/** The hop into the runtime is the only thing stubbed. */
const dispatched: any[] = []
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
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
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
const bus = await import('../lib/conversation-bus')

const db = prisma as any
let seed: SeededWorkspace
/** The agent that hands the card off and watches it — not the one that holds it. */
let watcher: string

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
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const asProject = (projectId: string) => ({ 'x-identity': JSON.stringify({ kind: 'project', projectId }) })

/** The pattern the runtime hands the API when an agent hands a card off. */
const HANDOFF_UNTIL = 'moved to [^\\n]*\\((review|waiting|done|dismissed)\\)|(^|\\n)agent (stopped|failed)'

let n = 0

/** A watched card, in an active lane, assigned to this project's agent. */
async function watchedCard() {
  const name = `sho369-${++n}`
  await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name }, { 'x-user': seed.member })
  const agent = (method: string, path: string, body?: unknown) =>
    call(method, `/internal/workspaces/${seed.workspaceId}${path}`, body, { 'x-project': seed.projectId })
  const board = await agent('POST', '/agent-boards', {
    channel: `#${name}`,
    name,
    columns: [
      { name: 'In Development', category: 'active' },
      { name: 'QA & Review', category: 'active' },
      { name: 'PR Open', category: 'review' },
      { name: 'Needs attention', category: 'waiting' },
      { name: 'Done', category: 'done' },
    ],
  })
  const card = await agent('POST', `/agent-boards/${board.json.board.slug}/items`, {
    title: 'Wake once',
    assignee_agent: `project:${seed.projectId}`,
  })
  const item = await db.workItem.findUnique({ where: { id: card.json.item.id } })
  const session = await db.chatSession.create({
    data: { inferredName: 'Watches the card', contextType: 'project', contextId: watcher, createdByUserId: seed.owner },
  })
  const watchId = tasks.newTaskId()
  const created = await call('POST', '/internal/tasks', {
    id: watchId,
    chatSessionId: session.id,
    source: 'work_item',
    targetRef: item.id,
    title: card.json.item.key,
    until: HANDOFF_UNTIL,
  }, asProject(watcher))
  expect(created.status).toBe(201)
  const move = (column: string) => agent('POST', `/agent-work-items/${card.json.item.key}/move`, { column })
  return { item, session, watchId, key: card.json.item.key as string, move }
}

/** The wake turns the API actually dispatched for this watch. */
const wakesFor = (watchId: string) => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(watchId))

/** Every queued wake row the session has for this task, right now. */
const queuedFor = (sessionId: string, taskId: string) =>
  db.chatQueuedMessage.findMany({ where: { sessionId, kind: 'task_notification' } })
    .then((rows: any[]) => rows.filter((row) => tasks.taskWakeIdsFromBody(row.body).includes(taskId)))

/** A session that is mid-turn: the queue takes the wake but may not start it. */
async function busy(sessionId: string) {
  await db.chatSession.update({
    where: { id: sessionId },
    data: { activeTurnId: `turn-${sessionId}`, activeTurnStartedAt: new Date(), activeTurnHeartbeatAt: new Date() },
  })
}

/** Queue the wake without letting the dispatcher start a turn. */
async function queueWake(sessionId: string) {
  tasks._testing.clearTimers()
  return tasks.enqueueTaskWake(sessionId, { dispatch: false })
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  watcher = (await db.project.create({ data: { name: 'Assigner', workspaceId: seed.workspaceId } })).id
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

describe('SHO-369 · a busy watcher hears about a card once', () => {
  test('AC1: fifty run ends, then two moves, leave one update carrying the latest state', async () => {
    const c = await watchedCard()
    await busy(c.session.id)
    const { recordEvent } = await import('../services/work-boards.service')

    // The holder's lane runs on the card fifty times and never moves it.
    for (let i = 0; i < 50; i++) {
      await recordEvent(c.item, 'agent_stopped', { agentRef: `project:${seed.projectId}` }, {
        column: 'In Development',
        messageId: `run-${i}`,
        assigneeAgentRef: `project:${seed.projectId}`,
      })
      // Queued, not armed: the watch is still the settled row with its wake
      // waiting, so the next stop lands on the same queued update.
      expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
      await queueWake(c.session.id)
      expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)
    }

    // Then the card really moves: QA (active, not a wake point) and PR Open (review).
    await c.move('QA & Review')
    await queueWake(c.session.id)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)
    await c.move('PR Open')
    await queueWake(c.session.id)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)

    // The session frees up.
    await db.chatSession.update({ where: { id: c.session.id }, data: { activeTurnId: null } })
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(await dispatchNext(c.session.id)).toBe(false)

    // Exactly one wake, one block, and it reads the card as it is now.
    expect(wakesFor(c.watchId)).toHaveLength(1)
    const turn = wakesFor(c.watchId)[0]!
    expect(String(turn.text).match(/\[Task update\]/g) ?? []).toHaveLength(1)
    expect(String(turn.text)).toContain('moved to PR Open (review)')
    expect(String(turn.text)).toContain('moved to QA & Review (active)')
    expect(String(turn.text)).toContain('agent stopped with the card still in In Development')
    expect(await db.chatQueuedMessage.count({ where: { sessionId: c.session.id } })).toBe(0)

    // Delivered, so the watch is armed again for the rest of the card's life.
    const armed = (await tasks.getTask(c.watchId))!
    expect(armed.status).toBe('running')
    expect(armed.consumed).toBe(false)
    expect(armed.id).toBe(c.watchId)
  }, 30_000)

  test('AC2: a pre-upgrade backlog of 200 copies of one card is delivered as one block', async () => {
    const c = await watchedCard()
    const { formatTaskNote } = tasks
    // Exactly what v2.6.8 left behind: the watch re-armed on every queue, then
    // settled again, so hundreds of pending rows carried the same task id.
    await db.backgroundTask.update({
      where: { id: c.watchId },
      data: { status: 'completed', summary: `matched ${HANDOFF_UNTIL}`, finishedAt: new Date(), notifiedAt: new Date() },
    })
    const text = formatTaskNote((await tasks.getTask(c.watchId))!)
    expect(text).toContain('[Task update]')
    for (let i = 0; i < 200; i++) {
      await db.chatQueuedMessage.create({
        data: {
          sessionId: c.session.id,
          userId: seed.owner,
          position: i,
          status: 'pending',
          kind: 'task_notification',
          content: text,
          parts: JSON.stringify([
            { type: 'text', text },
            { type: 'data-task-notification', data: { taskIds: [c.watchId] } },
          ]),
          body: JSON.stringify({ text, taskNotification: { taskIds: [c.watchId] } }),
        },
      })
    }
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(200)

    expect(await dispatchNext(c.session.id)).toBe(true)

    // One turn, one block, and the other 199 rows are gone rather than queued
    // for the next turn.
    expect(wakesFor(c.watchId)).toHaveLength(1)
    expect(String(wakesFor(c.watchId)[0]!.text).match(/\[Task update\]/g) ?? []).toHaveLength(1)
    expect(await db.chatQueuedMessage.count({ where: { sessionId: c.session.id } })).toBe(0)
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')
  }, 30_000)
})

describe('SHO-369 · one wake per card state', () => {
  test('AC3: repeated stops in one column wake once, a move then a stop wakes again, and a move to waiting still wakes', async () => {
    const { noteCardRunEnded } = await import('../services/work-boards.service')
    const c = await watchedCard()
    // Stopped by a person, so no re-hand runs: the emit rule is the same for
    // every run end that leaves the card where it was.
    const stop = (i: number) => noteCardRunEnded({
      threadRootId: c.item.threadRootMessageId,
      projectId: seed.projectId,
      messageId: `stop-${i}`,
      agentStatus: 'stopped',
    })

    for (let i = 0; i < 3; i++) await stop(i)
    expect(await db.workItemEvent.count({ where: { workItemId: c.item.id, type: 'agent_stopped' } })).toBe(3)
    const stopped = (await tasks.getTask(c.watchId))!
    expect(stopped.status).toBe('completed')
    expect(stopped.output.match(/agent stopped/g) ?? []).toHaveLength(1)
    await queueWake(c.session.id)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)

    // Deliver it, so the watch is armed for the next state.
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')

    // A move to a lane that is not a wake point does not settle anything…
    await c.move('QA & Review')
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')
    expect(await queueWake(c.session.id)).toBe(false)

    // …but the stop that follows it is a new state and wakes the watcher.
    await stop(9)
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    await queueWake(c.session.id)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)
    expect(await dispatchNext(c.session.id)).toBe(true)

    // The escalation move still wakes the watcher: a lane that means "a person
    // must look" is a milestone like any other.
    const before = wakesFor(c.watchId).length
    await c.move('Needs attention')
    await queueWake(c.session.id)
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(wakesFor(c.watchId)).toHaveLength(before + 1)
    expect(String(wakesFor(c.watchId).at(-1)!.text)).toContain('moved to Needs attention (waiting)')
  }, 30_000)

  test('AC4: a comment never settles the watch, however its text reads', async () => {
    const { recordEvent } = await import('../services/work-boards.service')
    const c = await watchedCard()
    const before = await tasks.getTask(c.watchId)
    expect(before!.status).toBe('running')

    // A comment that quotes a milestone…
    await recordEvent(c.item, 'commented', { agentRef: `project:${seed.projectId}` }, { text: 'moved to QA (review) — nice work' })
    // …and a multi-line one that quotes a stop.
    await recordEvent(c.item, 'commented', { agentRef: `project:${seed.projectId}` }, {
      text: 'status:\nagent stopped with the card still in In Development\nnothing else to add',
    })
    expect(await db.workItemEvent.count({ where: { workItemId: c.item.id, type: 'commented' } })).toBe(2)

    const row = (await tasks.getTask(c.watchId))!
    expect(row.status).toBe('running')
    expect(await queueWake(c.session.id)).toBe(false)
    // One event is one line: `until` can never match a comment's prose.
    expect(row.output.split('\n')).toHaveLength(2)
    expect(row.output).toContain('agent stopped with the card still in In Development')
    expect(row.output.match(/^comment: /gm) ?? []).toHaveLength(2)

    // The waiting side reads the same timeline, so it does not match either.
    const waited = await tasks.waitForTask(c.watchId, { until: HANDOFF_UNTIL, waitMs: 0 })
    expect(waited?.matched).toBe(false)
    expect(waited?.row.status).toBe('running')

    // A real move still matches, through the same path.
    await c.move('PR Open')
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    await queueWake(c.session.id)
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(wakesFor(c.watchId)).toHaveLength(1)
    expect(String(wakesFor(c.watchId)[0]!.text)).toContain('moved to PR Open (review)')
  }, 30_000)

  test('AC6: the watchdog`s one failure note wakes the watcher once, and the sweeps after it send nothing', async () => {
    const { recordEvent } = await import('../services/work-boards.service')
    const c = await watchedCard()

    // What the watchdog reports for a run that went quiet: one `agent_failed`.
    await recordEvent(c.item, 'agent_failed', { agentRef: `project:${seed.projectId}` }, {
      messageId: 'quiet-run',
      assigneeAgentRef: `project:${seed.projectId}`,
    })
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    expect(await queueWake(c.session.id)).toBe(true)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)
    expect(await dispatchNext(c.session.id)).toBe(true)

    // Every later sweep and turn end finds nothing to send.
    expect(await tasks.sweepUnnotifiedWakes()).toBe(0)
    expect(await queueWake(c.session.id)).toBe(false)
    expect(await dispatchNext(c.session.id)).toBe(false)
    expect(wakesFor(c.watchId)).toHaveLength(1)
    expect(String(wakesFor(c.watchId)[0]!.text)).toContain('agent failed on the card')
    expect(await db.chatQueuedMessage.count({ where: { sessionId: c.session.id } })).toBe(0)
  }, 30_000)
})
