// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-30: the wake is delivered exactly once.
 *
 * The dev's `task-wake-recovery.test.ts` proves a dropped wake comes back. This
 * file pins the other half of the contract — that making it durable did not
 * make it noisy: one task is one wake, a held card watch is not swept early, an
 * expired task is not swept at all, and a wake that keeps failing backs off.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const dispatched: any[] = []
let runtimeDown = false

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      const body = JSON.parse(await request.text())
      if (runtimeDown) throw new Error('runtime not ready')
      dispatched.push(body)
      return new Response(null, { status: 200 })
    },
  }),
}))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')
const { runChatQueueDrain } = await import('../jobs/run-chat-queue-drain')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api/internal', runtimeInternalRoutes({
  authenticate: async (c: any) => (c.req.header('x-identity') ? JSON.parse(c.req.header('x-identity')!) : null),
  saveAgentAvatar: async () => ({}) as any,
  metalWorkspaceMember: (async () => null) as any,
} as any))

async function newSession(): Promise<string> {
  const s = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return s.id
}

/** A finished shell task arrives the way the runtime reports it. */
async function notifyShellTask(chatSessionId: string, id: string) {
  const res = await app.request('/api/internal/tasks/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-identity': JSON.stringify({ kind: 'project', projectId: seed.projectId }) },
    body: JSON.stringify({
      chatSessionId,
      tasks: [{ id, source: 'shell', title: 'build', status: 'completed', text: `[Task update] build (${id}) completed.` }],
    }),
  })
  expect(res.status).toBe(200)
}

/** Every queued row the session has, oldest first. */
async function queueRows(sessionId: string) {
  return db.chatQueuedMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
}

beforeAll(async () => { seed = await seedWorkspace(db) })
afterEach(() => { tasks._testing.clearTimers(); dispatched.length = 0; runtimeDown = false })

describe('SHO-30 acceptance: the wake is delivered exactly once', () => {
  test('the coalesce timer and the drain tick produce one wake, not two', async () => {
    const session = await newSession()
    await notifyShellTask(session, 't_once0001')

    // The 2 s coalesce timer is still armed when the drain worker runs.
    await runChatQueueDrain()
    await waitFor(async () => dispatched.length > 0)

    // Let the coalesce timer fire and run another tick: neither may repeat it.
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    await runChatQueueDrain()

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toContain('t_once0001')
    expect((await queueRows(session)).filter((r: any) => r.kind === 'task_notification')).toHaveLength(0)
  })

  test('a wake that ran is consumed even when the reply saved no text', async () => {
    const session = await newSession()
    await notifyShellTask(session, 't_empt0001')
    tasks._testing.clearTimers()

    await runChatQueueDrain()
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched).toHaveLength(1)

    // The turn ran, so the note is seen — even if that turn wrote nothing back.
    expect((await db.backgroundTask.findUnique({ where: { id: 't_empt0001' } })).consumed).toBe(true)

    // A later release of the same task cannot wake the session for it again.
    await db.backgroundTask.update({ where: { id: 't_empt0001' }, data: { notifiedAt: null } })
    await runChatQueueDrain()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(dispatched).toHaveLength(1)
  })

  test('a held card watch is not swept before its hold expires', async () => {
    const session = await newSession()
    const row = await tasks.createTask({
      id: 't_held0001', chatSessionId: session, source: 'work_item', targetRef: 'item-held', title: 'card watch',
    })
    await db.backgroundTask.update({
      where: { id: row.id },
      data: { status: 'completed', finishedAt: new Date(), summary: 'card finished' },
    })
    await tasks.holdTasks([await db.backgroundTask.findUnique({ where: { id: row.id } })])
    tasks._testing.clearTimers()   // only the drain may act from here

    await runChatQueueDrain()
    expect(dispatched).toHaveLength(0)

    await db.backgroundTask.update({ where: { id: row.id }, data: { heldUntil: null } })
    await runChatQueueDrain()
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toContain('t_held0001')
  })

  test('an expired task is not swept', async () => {
    const session = await newSession()
    await notifyShellTask(session, 't_gone0001')
    await db.backgroundTask.update({ where: { id: 't_gone0001' }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    tasks._testing.clearTimers()

    await runChatQueueDrain()
    expect(dispatched).toHaveLength(0)
    expect(await queueRows(session)).toHaveLength(0)
  })

  test('a failed wake releases only its own task, not the rest of the burst', async () => {
    const session = await newSession()
    await notifyShellTask(session, 't_own0001')
    await notifyShellTask(session, 't_own0002')
    tasks._testing.clearTimers()
    expect(await tasks.enqueueTaskWake(session, { dispatch: false })).toBe(true)
    expect(await queueRows(session)).toHaveLength(2)

    runtimeDown = true
    await runChatQueueDrain()                     // the first row fails and is handed back
    expect(dispatched).toHaveLength(0)
    const failed = await db.backgroundTask.findUnique({ where: { id: 't_own0001' } })
    const untouched = await db.backgroundTask.findUnique({ where: { id: 't_own0002' } })
    expect(failed.notifiedAt).toBeNull()
    expect(failed.attempts).toBe(1)
    expect(untouched.notifiedAt).not.toBeNull()   // its own row still owns it
    expect(untouched.attempts).toBe(0)

    runtimeDown = false
    await runChatQueueDrain()                     // the second row runs; the first is swept back
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched[0].taskNotification).toEqual({ taskIds: ['t_own0002'] })

    await runChatQueueDrain()
    await waitFor(async () => dispatched.length > 1)
    expect(dispatched[1].taskNotification).toEqual({ taskIds: ['t_own0001'] })
  })

  test('a wake that keeps failing backs off instead of hot-looping, then lands once', async () => {
    const session = await newSession()
    runtimeDown = true
    await notifyShellTask(session, 't_retry0001')
    tasks._testing.clearTimers()

    await runChatQueueDrain()                      // claims, fails, hands the claim back
    const first = await db.backgroundTask.findUnique({ where: { id: 't_retry0001' } })
    expect(first.notifiedAt).toBeNull()             // the claim was released, not held
    expect(first.attempts).toBe(1)

    await runChatQueueDrain()                      // the immediate retry the first backoff allows
    expect(dispatched).toHaveLength(0)
    const second = await db.backgroundTask.findUnique({ where: { id: 't_retry0001' } })
    expect(second.attempts).toBe(2)
    expect(second.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 5_000)

    await runChatQueueDrain()                      // inside the 15 s window: no third attempt
    expect(dispatched).toHaveLength(0)
    expect((await db.backgroundTask.findUnique({ where: { id: 't_retry0001' } })).attempts).toBe(2)

    runtimeDown = false
    await db.backgroundTask.update({ where: { id: 't_retry0001' }, data: { nextAttemptAt: null } })
    await runChatQueueDrain()
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toContain('t_retry0001')

    await runChatQueueDrain()                      // consumed now: no second wake
    expect(dispatched).toHaveLength(1)
  })
})
