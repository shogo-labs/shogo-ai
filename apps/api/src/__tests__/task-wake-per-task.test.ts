import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

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
const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => { seed = await seedWorkspace(db) })

afterEach(() => {
  tasks._testing.clearTimers()
  dispatched.length = 0
})

async function newSession(): Promise<string> {
  const s = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return s.id
}

describe('one message per finished task', () => {
  test('three tasks finishing 200 ms apart queue three separate wakes, in finish order', async () => {
    const session = await newSession()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = tasks.newTaskId()
      ids.push(id)
      await tasks.createTask({ id, chatSessionId: session, source: 'agent_reply', targetRef: `msg-burst-${i}:ws`, title: `@Ops reply ${i}` })
    }
    for (let i = 0; i < 3; i++) {
      await tasks.emitTaskEvent('agent_reply', `msg-burst-${i}:ws`, { status: 'completed', line: `done ${i}` })
      await new Promise((r) => setTimeout(r, 200))
    }
    tasks._testing.clearTimers()

    await tasks.enqueueTaskWake(session)

    const rows = await db.chatQueuedMessage.findMany({
      where: { sessionId: session },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })
    const taskIds = rows.map((r: any) => JSON.parse(r.body).taskNotification?.taskIds)
    expect(rows).toHaveLength(3)
    expect(taskIds).toEqual(ids.map((id) => [id]))
    for (const row of rows) {
      expect((row.content.match(/\[Task update\]/g) ?? []).length).toBe(1)
    }
  })

  test('a burst is queued in finish order, not in the order the tasks were created', async () => {
    const session = await newSession()
    const ids: Record<string, string> = {}
    for (const name of ['a', 'b', 'c']) {
      ids[name] = tasks.newTaskId()
      await tasks.createTask({
        id: ids[name]!,
        chatSessionId: session,
        source: 'agent_reply',
        targetRef: `msg-order-${name}:ws`,
        title: `@Ops ${name}`,
      })
    }
    for (const name of ['c', 'a', 'b']) {
      await tasks.emitTaskEvent('agent_reply', `msg-order-${name}:ws`, { status: 'completed', line: `done ${name}` })
      await new Promise((r) => setTimeout(r, 20))
    }
    tasks._testing.clearTimers()

    await tasks.enqueueTaskWake(session)

    const rows = await db.chatQueuedMessage.findMany({
      where: { sessionId: session },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })
    expect(rows.map((r: any) => JSON.parse(r.body).taskNotification.taskIds)).toEqual([
      [ids.c], [ids.a], [ids.b],
    ])
    expect(rows.map((r: any) => r.content.match(/@Ops (\w)/)[1])).toEqual(['c', 'a', 'b'])
  })

  test('several local tasks from one runtime flush queue one wake each', async () => {
    const session = await newSession()
    const notices = [0, 1].map((i) => ({
      id: `t_local10${i}`,
      source: 'shell',
      title: `bun test ${i}`,
      status: 'completed',
      text: `[Task update] bun test ${i} (t_local10${i}) completed.`,
    }))
    expect(await tasks.notifyLocalTasks(session, notices)).toBe(2)
    tasks._testing.clearTimers()

    await tasks.enqueueTaskWake(session)

    const rows = await db.chatQueuedMessage.findMany({ where: { sessionId: session } })
    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.content)).toEqual(notices.map((n) => n.text))
  })

  test('a sweep that recovers three tasks queues three wakes, not one', async () => {
    const session = await newSession()
    for (let i = 0; i < 3; i++) {
      const id = tasks.newTaskId()
      await tasks.createTask({ id, chatSessionId: session, source: 'agent_reply', targetRef: `msg-sweep-${i}:ws`, title: `@Ops reply ${i}` })
      await tasks.emitTaskEvent('agent_reply', `msg-sweep-${i}:ws`, { status: 'completed' })
    }
    tasks._testing.clearTimers()

    await tasks.sweepUnnotifiedWakes()

    const rows = await db.chatQueuedMessage.findMany({ where: { sessionId: session } })
    expect(rows).toHaveLength(3)
  })
})
