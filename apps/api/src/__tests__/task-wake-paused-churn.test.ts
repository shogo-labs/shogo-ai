// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-32: a paused session keeps one paused row, not one per retry.
 *
 * A paused wake is released back to the sweep, which retries it on a backoff
 * that caps at five minutes. While the session stays paused that is a fresh
 * failed `chat_queued_message` row (with a 4 KB error column) every cycle, for
 * up to the task's 24 h TTL. The row is still the UI's only "this session is
 * paused" signal, so it has to stay — exactly one of it.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

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

/**
 * Three wake turns in a row, each reporting a task created after the previous
 * wake started: three waits, so the session's wakes are paused.
 */
async function pauseSession(chatSessionId: string) {
  for (let i = 0; i < 3; i++) {
    const id = tasks.newTaskId()
    await db.backgroundTask.create({ data: {
      id, chatSessionId, source: 'agent_reply', targetRef: `earlier-${i}`, title: `@Ops reply ${i}`,
      status: 'completed', consumed: true, finishedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } })
    await db.chatMessage.create({ data: {
      id: `m_pause_${chatSessionId}_${i}`, sessionId: chatSessionId, role: 'user', content: `[Task update] earlier ${i}`,
      parts: JSON.stringify([
        { type: 'text', text: `[Task update] earlier ${i}` },
        { type: 'data-task-notification', data: { taskIds: [id] } },
      ]),
    } })
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The sweep only retries once its backoff has elapsed; move the clock instead of waiting it out. */
async function passBackoff(taskId: string) {
  await db.backgroundTask.update({ where: { id: taskId }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } })
}

function pausedRows(sessionId: string) {
  return db.chatQueuedMessage.findMany({ where: { sessionId, status: 'failed' } })
}

beforeAll(async () => { seed = await seedWorkspace(db) })
afterEach(() => { tasks._testing.clearTimers(); dispatched.length = 0 })

describe('SHO-32: a paused session does not accumulate failed rows', () => {
  test('ten drain ticks while paused leave one paused row', async () => {
    const session = await newSession()
    await pauseSession(session)
    await notifyShellTask(session, 't_paused001')
    tasks._testing.clearTimers()          // only the drain re-queues from here

    for (let tick = 0; tick < 10; tick++) {
      await runChatQueueDrain()
      expect((await pausedRows(session)).length).toBeLessThanOrEqual(1)
      await passBackoff('t_paused001')    // the 5-minute step between ticks
    }

    const rows = await pausedRows(session)
    expect(rows).toHaveLength(1)
    expect(rows[0].error).toContain('Paused')
    expect(rows[0].body).toContain('t_paused001')
    expect(dispatched).toHaveLength(0)
  })

  test('a person writing resumes the wake inside one backoff step and drops the paused row', async () => {
    const session = await newSession()
    await pauseSession(session)
    await notifyShellTask(session, 't_paused002')
    tasks._testing.clearTimers()

    await runChatQueueDrain()
    await passBackoff('t_paused002')
    await runChatQueueDrain()
    expect(await pausedRows(session)).toHaveLength(1)

    // A paused row is a deferral, not a transient failure: its retry stays
    // inside the five-minute cap, so a message from a person revives the wake
    // promptly instead of hours later.
    const paused = await db.backgroundTask.findUnique({ where: { id: 't_paused002' } })
    expect(paused.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(tasks.MAX_WAKE_BACKOFF_MS)

    await db.chatMessage.create({ data: { id: 'm_human_2', sessionId: session, role: 'user', content: 'carry on', parts: JSON.stringify([{ type: 'text', text: 'carry on' }]) } })
    await passBackoff('t_paused002')
    await runChatQueueDrain()
    await waitFor(async () => dispatched.length > 0)

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toContain('t_paused002')
    expect(await pausedRows(session)).toHaveLength(0)
  })
})
