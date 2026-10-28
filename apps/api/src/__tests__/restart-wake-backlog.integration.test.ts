// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A restart with a backlog of queued task wakes, against a real SQLite
 * database. On 2026-10-27 a desktop restart drained ~100 `[Task update]` rows
 * up to 2.5 days old in 90 s: 37 concurrent turns for one agent, most about
 * cards already Done, each one a duplicate of work the board had moved past.
 *
 * The drain must (1) drop wakes too old to be news instead of starting a turn,
 * (2) drop wakes about cards that are closed now once they are past a short
 * grace, and (3) start at most a few automatic wakes per agent per tick, while
 * a person's own queued message is never held back. Only the hop into the
 * runtime is stubbed.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const dispatched: any[] = []
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      dispatched.push(JSON.parse(await request.text()))
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const {
  dispatchPendingSessions,
  MAX_WAKES_PER_AGENT_PER_TICK,
  STALE_TASK_WAKE_MS,
  STALE_CLOSED_CARD_WAKE_MS,
} = await import('../services/chat-queue-dispatcher.service')

const db = prisma as any
let seed: SeededWorkspace
let n = 0

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(async () => {
  dispatched.length = 0
  tasks._testing.clearTimers()
  await db.chatQueuedMessage.deleteMany({})
  await db.backgroundTask.deleteMany({})
  await db.chatMessage.deleteMany({})
  await db.chatSession.deleteMany({})
  await db.workItem.deleteMany({})
  await db.boardColumn.deleteMany({})
  await db.board.deleteMany({})
})

async function newSession(projectId = seed.projectId): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: projectId, createdByUserId: seed.owner },
  })
  return session.id
}

async function card(category: 'active' | 'done'): Promise<string> {
  const id = ++n
  const board = await db.board.create({
    data: { workspaceId: seed.workspaceId, name: `B${id}`, slug: `b${id}`, keyPrefix: `B${id}` },
  })
  const column = await db.boardColumn.create({
    data: { boardId: board.id, name: category === 'done' ? 'Done' : 'Doing', category, position: 0 },
  })
  const item = await db.workItem.create({
    data: { workspaceId: seed.workspaceId, boardId: board.id, columnId: column.id, key: `B${id}-1`, number: 1, title: 'Card' },
  })
  return item.id
}

/** A finished, unseen task with its wake already queued `ageMs` ago, as a stalled queue leaves it. */
async function queuedWake(session: string, ageMs: number, opts: { cardId?: string } = {}) {
  const task = await tasks.createTask({
    id: tasks.newTaskId(),
    chatSessionId: session,
    source: opts.cardId ? 'work_item' : 'agent_reply',
    targetRef: opts.cardId ?? `reply-${++n}`,
    title: opts.cardId ? 'SHO-1 card' : 'Planner reply',
  })
  const at = new Date(Date.now() - ageMs)
  await db.backgroundTask.update({
    where: { id: task.id },
    data: { status: 'completed', summary: 'moved to Done', finishedAt: at, notifiedAt: at, consumed: false },
  })
  const text = `[Task update] ${task.title} (${task.id}) completed.`
  const row = await db.chatQueuedMessage.create({
    data: {
      sessionId: session,
      userId: seed.owner,
      position: 0,
      status: 'pending',
      kind: 'task_notification',
      content: text,
      parts: JSON.stringify([{ type: 'text', text }, { type: 'data-task-notification', data: { taskIds: [task.id] } }]),
      body: JSON.stringify({ text, taskNotification: { taskIds: [task.id] } }),
      createdAt: at,
    },
  })
  return { task, row }
}

describe('restart with a queued wake backlog', () => {
  test('a wake older than the stale window is dropped and marked seen, not started', async () => {
    const session = await newSession()
    const { task, row } = await queuedWake(session, STALE_TASK_WAKE_MS + 60_000)

    expect(await dispatchPendingSessions()).toBe(0)
    expect(dispatched).toHaveLength(0)
    expect(await db.chatQueuedMessage.findUnique({ where: { id: row.id } })).toBeNull()
    expect((await tasks.getTask(task.id))!.consumed).toBe(true)
    // The sweep has nothing to re-queue: the task is seen.
    expect(await tasks.sweepUnnotifiedWakes()).toBe(0)
  })

  test('a wake about a card that is Done now is dropped once past the short grace', async () => {
    const session = await newSession()
    const done = await card('done')
    const { row } = await queuedWake(session, STALE_CLOSED_CARD_WAKE_MS + 60_000, { cardId: done })

    expect(await dispatchPendingSessions()).toBe(0)
    expect(dispatched).toHaveLength(0)
    expect(await db.chatQueuedMessage.findUnique({ where: { id: row.id } })).toBeNull()
  })

  test('the same-age wake about an open card still runs', async () => {
    const session = await newSession()
    const open = await card('active')
    await queuedWake(session, STALE_CLOSED_CARD_WAKE_MS + 60_000, { cardId: open })

    expect(await dispatchPendingSessions()).toBe(1)
    expect(dispatched).toHaveLength(1)
  })

  test('a fresh wake about a card that just closed still runs (the assigner acts on Done)', async () => {
    const session = await newSession()
    const done = await card('done')
    await queuedWake(session, 60_000, { cardId: done })

    expect(await dispatchPendingSessions()).toBe(1)
  })

  test('a backlog for one agent drains a few sessions per tick, not all at once', async () => {
    const sessions: string[] = []
    for (let i = 0; i < 6; i++) {
      const s = await newSession()
      sessions.push(s)
      await queuedWake(s, 60_000)
    }

    expect(await dispatchPendingSessions()).toBe(MAX_WAKES_PER_AGENT_PER_TICK)
    expect(dispatched).toHaveLength(MAX_WAKES_PER_AGENT_PER_TICK)
    const left = await db.chatQueuedMessage.count({ where: { status: 'pending' } })
    expect(left).toBe(6 - MAX_WAKES_PER_AGENT_PER_TICK)
  })

  test('the per-agent cap is per agent: another agent still gets its wakes this tick', async () => {
    const other = await db.project.create({ data: { name: 'Other agent', workspaceId: seed.workspaceId } })
    for (let i = 0; i < 4; i++) await queuedWake(await newSession(), 60_000)
    for (let i = 0; i < 2; i++) await queuedWake(await newSession(other.id), 60_000)

    expect(await dispatchPendingSessions()).toBe(MAX_WAKES_PER_AGENT_PER_TICK + 2)
  })

  test("a person's queued message is never held back by the cap", async () => {
    for (let i = 0; i < 4; i++) await queuedWake(await newSession(), 60_000)
    const mine = await newSession()
    await db.chatQueuedMessage.create({
      data: {
        sessionId: mine, userId: seed.owner, position: 0, status: 'pending', kind: 'user',
        content: 'are you there?', body: JSON.stringify({ text: 'are you there?' }),
        createdAt: new Date(Date.now() + 1_000),
      },
    })

    expect(await dispatchPendingSessions()).toBe(MAX_WAKES_PER_AGENT_PER_TICK + 1)
    expect(dispatched.some((body) => body.text === 'are you there?')).toBe(true)
  })
})
