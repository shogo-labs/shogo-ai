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
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
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

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const asProject = (id: string) => ({ 'x-identity': JSON.stringify({ kind: 'project', projectId: id }) })

async function newSession(): Promise<string> {
  const s = await db.chatSession.create({ data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner } })
  return s.id
}
async function notifyShellTask(chatSessionId: string, id: string) {
  return call('POST', '/internal/tasks/notify', {
    chatSessionId,
    tasks: [{ id, source: 'shell', title: 'build', status: 'completed', text: `[Task update] build (${id}) completed.` }],
  }, asProject(seed.projectId))
}

beforeAll(async () => { seed = await seedWorkspace(db) })
afterEach(() => { tasks._testing.clearTimers(); dispatched.length = 0; runtimeDown = false })

describe('task wake recovery', () => {
  test('the drain worker recreates a wake the API process dropped', async () => {
    const session = await newSession()
    await notifyShellTask(session, 't_lost0001')
    tasks._testing.clearTimers()          // the API died before the 2s coalesce timer fired
    await runChatQueueDrain()             // the 15s job every API process runs
    expect(dispatched).toHaveLength(1)    // FAILS today: 0
  })

  test('a wake whose dispatch failed is retried instead of being dropped forever', async () => {
    const session = await newSession()
    runtimeDown = true
    await notifyShellTask(session, 't_lost0002')
    await tasks.enqueueTaskWake(session)
    await dispatchNext(session).catch(() => {})
    const row = await waitFor(async () => {
      const r = await db.chatQueuedMessage.findFirst({ where: { sessionId: session } })
      return r?.status === 'failed' ? r : null
    })
    expect(row?.status).toBe('failed')

    runtimeDown = false
    await runChatQueueDrain()
    expect(dispatched).toHaveLength(1)    // FAILS today: 0
  })

  test('the 3-wake pause releases its tasks once a person writes', async () => {
    const session = await newSession()
    for (let i = 0; i < 3; i++) {
      await db.chatMessage.create({ data: {
        id: `m_pause_${i}`, sessionId: session, role: 'user', content: `[Task update] earlier ${i}`,
        parts: JSON.stringify([{ type: 'text', text: `[Task update] earlier ${i}` }, { type: 'data-task-notification', data: {} }]),
      } })
    }
    await notifyShellTask(session, 't_lost0003')
    await tasks.enqueueTaskWake(session)
    await dispatchNext(session).catch(() => {})
    const paused = await waitFor(async () => {
      const r = await db.chatQueuedMessage.findFirst({ where: { sessionId: session } })
      return r?.status === 'failed' ? r : null
    })
    expect(paused?.error).toContain('Paused')

    await db.chatMessage.create({ data: { id: 'm_human_1', sessionId: session, role: 'user', content: 'carry on', parts: JSON.stringify([{ type: 'text', text: 'carry on' }]) } })
    await runChatQueueDrain()
    expect(dispatched).toHaveLength(1)    // FAILS today: 0
    expect(dispatched[0].text).toContain('t_lost0003')
  })

  test('an agent reply whose run never reports back is settled and wakes its watcher', async () => {
    const session = await newSession()
    const row = await tasks.createTask({
      id: 't_stuck001', chatSessionId: session, source: 'agent_reply', targetRef: 'msg-stuck:ws', title: '@Ops reply',
    })
    await db.backgroundTask.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - tasks.AGENT_REPLY_RECONCILE_MS - 60_000) },
    })

    await runChatQueueDrain()

    const settled = await db.backgroundTask.findUnique({ where: { id: row.id } })
    expect(settled.status).toBe('failed')
    expect(settled.summary).toContain('without reporting back')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toContain('t_stuck001')
  })
})
