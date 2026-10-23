// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-92 acceptance: a wake that cannot be delivered is held, never retried.
 *
 * The card's own tests pin the single-task case (one attempt, one row, one
 * delivery) and the five-attempt cap. This spec pins the three things those
 * leave open, each of which loses a person's work or revives something that
 * should stay dead if the hold's bookkeeping drifts:
 *
 * 1. Two tasks finish while the session is paused: the queue stays at one row,
 *    *both* tasks are held, and both updates arrive once the pause lifts — a
 *    batch hold that only parked the newest task would silently drop the other.
 * 2. A wake that gave up after `MAX_WAKE_ATTEMPTS` is never revived. A capped
 *    wake and a pause hold are stored identically (`heldUntil = expiresAt`), so
 *    the only thing separating them is the attempt counter; if that slips, a
 *    finished task's update either disappears forever or spams again.
 * 3. A card hold (`heldUntil = now + CARD_HOLD_MS`) is not read as a pause hold
 *    and handed back to the sweep when a person writes.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

/** The hop into the runtime is the only thing stubbed; `runtimeDown` makes it fail. */
const dispatched: any[] = []
let runtimeDown = false
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
const realProjectChat = await import('../routes/project-chat')
mock.module('../routes/project-chat', () => ({
  ...realProjectChat,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      if (runtimeDown) throw new Error('runtime not ready')
      dispatched.push(JSON.parse(await request.text()))
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()

async function newSession(name = 'Paused'): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: name, contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** Three wakes in a row, each reporting a task created after the previous one: the session pauses. */
async function pauseSession(chatSessionId: string): Promise<void> {
  for (let i = 0; i < tasks.MAX_CONSECUTIVE_WAKES; i++) {
    const id = tasks.newTaskId()
    await db.backgroundTask.create({
      data: {
        id, chatSessionId, source: 'agent_reply', targetRef: `old-${i}`, title: `@Ops reply ${i}`,
        status: 'completed', consumed: true, finishedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await db.chatMessage.create({
      data: {
        sessionId: chatSessionId, role: 'user', content: `[Task update] earlier ${i}`,
        parts: JSON.stringify([
          { type: 'text', text: `[Task update] earlier ${i}` },
          { type: 'data-task-notification', data: { taskIds: [id] } },
        ]),
      },
    })
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A finished task whose wake the dispatcher will try and fail to deliver. */
async function finishedTask(chatSessionId: string, tag: string) {
  const task = await tasks.createTask({
    id: tasks.newTaskId(), chatSessionId, source: 'agent_reply', targetRef: `ops:${tag}`, title: `@Ops reply ${tag}`,
  })
  await tasks.emitTaskEvent('agent_reply', `ops:${tag}`, { status: 'completed' })
  return task
}

/** Queue the wake and make the session idle, so `dispatchNext` will claim it. */
async function wakeNow(chatSessionId: string): Promise<void> {
  await db.chatSession.update({
    where: { id: chatSessionId },
    data: { activeTurnId: 'turn-1', activeTurnHeartbeatAt: new Date() },
  })
  tasks._testing.clearTimers()
  await tasks.enqueueTaskWake(chatSessionId, { dispatch: false })
  await db.chatSession.update({ where: { id: chatSessionId }, data: { activeTurnId: null, activeTurnHeartbeatAt: null } })
}

/** The sweep only retries once the backoff has elapsed; move the clock instead of waiting it out. */
async function forceRetryDue(taskId: string): Promise<void> {
  await db.backgroundTask.update({ where: { id: taskId }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } })
}

async function personWrites(chatSessionId: string): Promise<void> {
  await db.chatMessage.create({
    data: {
      sessionId: chatSessionId, role: 'user', content: 'carry on',
      parts: JSON.stringify([{ type: 'text', text: 'carry on' }]),
    },
  })
}

function pausedRows(sessionId: string) {
  return db.chatQueuedMessage.findMany({ where: { sessionId, status: 'failed' } })
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(() => {
  tasks._testing.clearTimers()
  dispatched.length = 0
  runtimeDown = false
})

describe('SHO-92 · a paused wake is held, not retried', () => {
  test('two tasks finishing while paused: one row, both held, both delivered once the pause lifts', async () => {
    const session = await newSession()
    await pauseSession(session)
    const first = await finishedTask(session, 'a')
    const second = await finishedTask(session, 'b')
    await wakeNow(session)

    await dispatchNext(session)
    const paused = await waitFor(async () => {
      const rows = await pausedRows(session)
      return rows.length ? rows[0]! : null
    }, 5_000)
    expect(paused.error).toContain('Paused')
    const rowCreatedAt = paused.createdAt.getTime()

    // Both tasks are parked, not just the one the surviving marker row names.
    for (const task of [first, second]) {
      const held = await db.backgroundTask.findUnique({ where: { id: task.id } })
      expect(held.heldUntil!.getTime()).toBe(held.expiresAt.getTime())
      expect(held.heldUntil!.getTime()).toBeGreaterThan(Date.now())
      expect(held.notifiedAt).not.toBeNull()
      expect(held.attempts).toBe(1)
      expect(held.nextAttemptAt).toBeNull()
      expect(held.consumed).toBe(false)
    }

    // Twenty sweep ticks (five minutes of the drain worker's 15 s cadence): the
    // row a person is looking at never changes and nothing is re-queued.
    for (let tick = 0; tick < 20; tick++) {
      await forceRetryDue(first.id)
      await forceRetryDue(second.id)
      await tasks.sweepUnnotifiedWakes()
      await dispatchNext(session)
    }
    const rows = await pausedRows(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(paused.id)
    expect(rows[0]!.createdAt.getTime()).toBe(rowCreatedAt)
    expect(dispatched).toHaveLength(0)

    // A person writes: the pause lifts and both owed updates arrive.
    await personWrites(session)
    await tasks.sweepUnnotifiedWakes()
    await dispatchNext(session)
    await dispatchNext(session)
    await waitFor(async () => (dispatched.length >= 2 ? true : null), 5_000)

    const woken = dispatched.flatMap((body) => body.taskNotification.taskIds as string[]).sort()
    expect(woken).toEqual([first.id, second.id].sort())
    for (const task of [first, second]) {
      expect((await db.backgroundTask.findUnique({ where: { id: task.id } })).consumed).toBe(true)
    }
    // And the pause marker is gone once a wake actually landed.
    expect(await pausedRows(session)).toHaveLength(0)

    // Nothing is delivered a second time on later ticks.
    await tasks.sweepUnnotifiedWakes()
    await dispatchNext(session)
    expect(dispatched).toHaveLength(2)
  }, 30_000)

  test('a wake that gave up after five attempts is never revived, even when a person writes', async () => {
    const session = await newSession()
    const task = await finishedTask(session, 'never')
    await wakeNow(session)

    runtimeDown = true
    try {
      for (let round = 0; round < 6; round++) {
        await forceRetryDue(task.id)
        await tasks.sweepUnnotifiedWakes()
        await dispatchNext(session)
      }
    } finally {
      runtimeDown = false
    }

    // The cap itself: five attempts, no more and no fewer.
    expect(tasks.MAX_WAKE_ATTEMPTS).toBe(5)
    const capped = await db.backgroundTask.findUnique({ where: { id: task.id } })
    expect(capped.attempts).toBe(tasks.MAX_WAKE_ATTEMPTS)
    expect(capped.heldUntil!.getTime()).toBe(capped.expiresAt.getTime())
    expect(capped.consumed).toBe(false)
    expect(capped.notifiedAt).not.toBeNull()
    const rows = await pausedRows(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.error).toContain(`after ${tasks.MAX_WAKE_ATTEMPTS} attempts`)

    // The pause-lift pass must leave it alone: a capped wake is not a hold.
    await personWrites(session)
    for (let tick = 0; tick < 3; tick++) {
      await forceRetryDue(task.id)
      await tasks.sweepUnnotifiedWakes()
      await dispatchNext(session)
    }
    expect(dispatched).toHaveLength(0)
    expect((await db.backgroundTask.findUnique({ where: { id: task.id } })).attempts).toBe(tasks.MAX_WAKE_ATTEMPTS)
    const after = await pausedRows(session)
    expect(after).toHaveLength(1)
    expect(after[0]!.error).toContain(`after ${tasks.MAX_WAKE_ATTEMPTS} attempts`)
  }, 30_000)

  test('a card hold is not read as a pause hold and handed back to the sweep', async () => {
    const session = await newSession('Card hold')
    const heldUntil = new Date(Date.now() + tasks.CARD_HOLD_MS)
    const task = await tasks.createTask({
      id: tasks.newTaskId(), chatSessionId: session, source: 'work_item', targetRef: 'card-1', title: 'Card moved',
    })
    await db.backgroundTask.update({
      where: { id: task.id },
      data: { status: 'completed', consumed: false, notifiedAt: new Date(), heldUntil, finishedAt: new Date() },
    })

    await personWrites(session)
    for (let tick = 0; tick < 3; tick++) {
      await forceRetryDue(task.id)
      await tasks.sweepUnnotifiedWakes()
      await dispatchNext(session)
    }

    const row = await db.backgroundTask.findUnique({ where: { id: task.id } })
    expect(row.heldUntil.getTime()).toBe(heldUntil.getTime())
    expect(row.notifiedAt).not.toBeNull()
    expect(await db.chatQueuedMessage.findMany({ where: { sessionId: session } })).toHaveLength(0)
    expect(dispatched).toHaveLength(0)
  }, 30_000)
})
