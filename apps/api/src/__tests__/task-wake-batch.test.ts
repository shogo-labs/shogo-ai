import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
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
const { dispatchNext, dispatchQueuedRow } = await import('../services/chat-queue-dispatcher.service')
const { setWorkspacePause, resetWorkspacePauseCache } = await import('../services/workspace-pause.service')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => { seed = await seedWorkspace(db) })

afterEach(async () => {
  tasks._testing.clearTimers()
  dispatched.length = 0
  runtimeDown = false
  resetWorkspacePauseCache()
})

async function newSession(): Promise<string> {
  const s = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return s.id
}

/** An API-tracked task that finishes now, so `enqueueTaskWake` queues one row for it. */
async function finishAgentReply(session: string, tag: string, line = `done ${tag}`): Promise<string> {
  const id = tasks.newTaskId()
  await tasks.createTask({ id, chatSessionId: session, source: 'agent_reply', targetRef: `msg-${tag}:ws`, title: `@Ops reply ${tag}` })
  await tasks.emitTaskEvent('agent_reply', `msg-${tag}:ws`, { status: 'completed', line })
  return id
}

async function finishMany(session: string, tags: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const tag of tags) ids.push(await finishAgentReply(session, tag))
  return ids
}

async function queuedRows(session: string): Promise<any[]> {
  return db.chatQueuedMessage.findMany({
    where: { sessionId: session },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })
}

function wakeIdsOf(body: any): string[] {
  const parts = body?.messages?.[0]?.parts ?? []
  const part = parts.find((p: any) => p?.type === 'data-task-notification')
  return Array.isArray(part?.data?.taskIds) ? part.data.taskIds : []
}

function textOf(body: any): string {
  const parts = body?.messages?.[0]?.parts ?? []
  return String(parts.find((p: any) => p?.type === 'text')?.text ?? body?.text ?? '')
}

function wakeBlocks(body: any): number {
  return (textOf(body).match(/\[Task update\]/g) ?? []).length
}

/** The user messages the queue persisted for this session, oldest first. */
async function persistedWakes(session: string): Promise<Array<{ ids: string[]; text: string }>> {
  const messages: Array<{ parts: string | null; content: string }> = await db.chatMessage.findMany({
    where: { sessionId: session, role: 'user' },
    orderBy: { createdAt: 'asc' },
  })
  return messages.map((message) => {
    const parts = message.parts ? JSON.parse(message.parts) : []
    const part = Array.isArray(parts) ? parts.find((p: any) => p?.type === 'data-task-notification') : null
    return {
      ids: Array.isArray(part?.data?.taskIds) ? part.data.taskIds : [],
      text: String(message.content ?? ''),
    }
  }).filter((message) => message.ids.length > 0)
}

async function insertPersonRow(session: string, text: string): Promise<string> {
  const latest = await db.chatQueuedMessage.findFirst({
    where: { sessionId: session },
    orderBy: [{ position: 'desc' }, { createdAt: 'desc' }],
    select: { position: true },
  })
  const row = await db.chatQueuedMessage.create({
    data: {
      sessionId: session,
      userId: seed.owner,
      position: (latest?.position ?? -1) + 1,
      status: 'pending',
      kind: 'user',
      content: text,
      parts: JSON.stringify([{ type: 'text', text }]),
      body: JSON.stringify({ text }),
    },
  })
  return row.id
}

async function setRunningTurn(session: string): Promise<void> {
  await db.chatSession.update({
    where: { id: session },
    data: { activeTurnId: `turn-${session}`, activeTurnStartedAt: new Date(), activeTurnHeartbeatAt: new Date() },
  })
}

async function endRunningTurn(session: string): Promise<void> {
  await db.chatSession.update({
    where: { id: session },
    data: { activeTurnId: null, activeTurnStartedAt: null, activeTurnHeartbeatAt: null },
  })
}

/** Drain until nothing is left to start, collecting the turns that started. */
async function drain(session: string): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    if (!(await dispatchNext(session))) return
  }
}

describe('batched task wakes (SHO-604)', () => {
  test('AC1: three tasks finishing together queue three rows and start ONE turn carrying all three', async () => {
    const session = await newSession()
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()

    await tasks.enqueueTaskWake(session, { dispatch: false })
    expect(await queuedRows(session)).toHaveLength(3)

    await drain(session)

    expect(dispatched).toHaveLength(1)
    expect(wakeBlocks(dispatched[0]!)).toBe(3)
    expect(wakeIdsOf(dispatched[0]!).sort()).toEqual([...ids].sort())

    const wakes = await persistedWakes(session)
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.ids).toHaveLength(3)
    expect((wakes[0]!.text.match(/\[Task update\]/g) ?? []).length).toBe(3)
    // Finish order is the queue order, so the blocks read a, b, c.
    expect(wakes[0]!.text.indexOf('@Ops reply a')).toBeLessThan(wakes[0]!.text.indexOf('@Ops reply b'))
    expect(wakes[0]!.text.indexOf('@Ops reply b')).toBeLessThan(wakes[0]!.text.indexOf('@Ops reply c'))

    for (const id of ids) {
      expect((await db.backgroundTask.findUnique({ where: { id } })).consumed).toBe(true)
    }
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test('AC2: tasks that finish while a turn runs wake it once when that turn ends', async () => {
    const session = await newSession()
    await setRunningTurn(session)
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    // A running turn is not interrupted: the rows wait for its end.
    expect(await dispatchNext(session)).toBe(false)
    expect(dispatched).toHaveLength(0)

    await endRunningTurn(session)
    await drain(session)

    expect(dispatched).toHaveLength(1)
    expect(wakeIdsOf(dispatched[0]!).sort()).toEqual([...ids].sort())
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test("AC3: a person's message between two wakes is never merged and never overtaken", async () => {
    const session = await newSession()
    const first = await finishAgentReply(session, 'a')
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    await insertPersonRow(session, 'a message from a person')
    const second = await finishAgentReply(session, 'b')
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    expect(await queuedRows(session)).toHaveLength(3)

    await drain(session)

    expect(dispatched).toHaveLength(3)
    // Turn 1: the wake before the message, on its own.
    expect(wakeIdsOf(dispatched[0]!)).toEqual([first])
    // Turn 2: the person's message, exactly as they wrote it.
    expect(dispatched[1]!.text).toBe('a message from a person')
    // Turn 3: the wake after it, still its own turn.
    expect(wakeIdsOf(dispatched[2]!)).toEqual([second])
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test('AC4: a `wake: "alone"` task gets its own turn, and nothing after it is pulled in', async () => {
    const session = await newSession()
    const first = await finishAgentReply(session, 'a')
    // A local task created with wake: "alone" (exec / agent_spawn / project_call).
    const aloneId = 't_alone001'
    await tasks.notifyLocalTasks(session, [
      { id: aloneId, source: 'shell', title: 'slow build', status: 'completed', text: `[Task update] slow build (${aloneId}) completed.`, wakeAlone: true },
    ])
    const third = await finishAgentReply(session, 'c')
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    expect(await queuedRows(session)).toHaveLength(3)

    await drain(session)

    expect(dispatched).toHaveLength(3)
    expect(wakeIdsOf(dispatched[0]!)).toEqual([first])
    expect(wakeIdsOf(dispatched[1]!)).toEqual([aloneId])
    expect(wakeIdsOf(dispatched[2]!)).toEqual([third])
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test('AC4b: with nothing marked alone, the same two wakes share one turn', async () => {
    const session = await newSession()
    const first = await finishAgentReply(session, 'a')
    const second = await finishAgentReply(session, 'c')
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })

    await drain(session)

    expect(dispatched).toHaveLength(1)
    expect(wakeIdsOf(dispatched[0]!).sort()).toEqual([first, second].sort())
  })

  test('AC5: a merged wake that fails releases every task, and they arrive merged on the retry', async () => {
    const session = await newSession()
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })

    runtimeDown = true
    expect(await dispatchNext(session)).toBe(false)
    runtimeDown = false

    const failed = await waitFor(async () => {
      const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: session, status: 'failed' } })
      return row ?? null
    })
    expect(failed).toBeTruthy()
    for (const id of ids) {
      const task = await db.backgroundTask.findUnique({ where: { id } })
      expect(task.consumed).toBe(false)
      expect(task.notifiedAt).toBeNull()
      expect(task.attempts).toBe(1)
    }

    const reQueued = await tasks.sweepUnnotifiedWakes()
    expect(reQueued).toBe(1)
    await drain(session)

    expect(dispatched).toHaveLength(1)
    expect(wakeIdsOf(dispatched[0]!).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      const task = await db.backgroundTask.findUnique({ where: { id } })
      expect(task.consumed).toBe(true)
      expect(task.attempts).toBe(1)
    }
    // The failed first attempt keeps its row as history; nothing is left to run.
    expect(await db.chatQueuedMessage.count({ where: { sessionId: session, status: 'pending' } })).toBe(0)
  })

  test('AC6: the task cap splits 14 pending wakes into 10 + 4', async () => {
    const session = await newSession()
    const tags = Array.from({ length: 14 }, (_, i) => `t${i}`)
    await finishMany(session, tags)
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    expect(await queuedRows(session)).toHaveLength(14)

    await drain(session)

    expect(dispatched).toHaveLength(2)
    expect(wakeIdsOf(dispatched[0]!)).toHaveLength(10)
    expect(wakeIdsOf(dispatched[1]!)).toHaveLength(4)
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test('AC6b: the text cap splits a batch that would be too long to read in one turn', async () => {
    const session = await newSession()
    const bulk = 'x'.repeat(3_000)
    const ids = Array.from({ length: 7 }, (_, i) => `t_big${i}00`)
    await tasks.notifyLocalTasks(session, ids.map((id, i) => ({
      id,
      source: 'shell',
      title: `bun test ${i}`,
      status: 'completed',
      text: `[Task update] bun test ${i} (${id}) completed.\n${bulk}`,
    })))
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })

    await drain(session)

    expect(dispatched).toHaveLength(2)
    expect(wakeBlocks(dispatched[0]!)).toBe(6)
    expect(wakeBlocks(dispatched[1]!)).toBe(1)
    for (const body of dispatched) expect(textOf(body).length).toBeLessThanOrEqual(20_000)
  })

  test('AC7: a row whose tasks the agent already saw is dropped, not delivered', async () => {
    const session = await newSession()
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    // The agent waited on the middle task between the rows being written and the turn.
    await tasks.consumeTasks([ids[1]!])

    await drain(session)

    expect(dispatched).toHaveLength(1)
    expect(wakeIdsOf(dispatched[0]!).sort()).toEqual([ids[0]!, ids[2]!].sort())
    expect(wakeBlocks(dispatched[0]!)).toBe(2)
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test('AC8: a workspace pause holds the wake with every id, and it runs once the pause lifts', async () => {
    const session = await newSession()
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    await setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), reason: 'test' })

    expect(await dispatchNext(session)).toBe(false)
    expect(dispatched).toHaveLength(0)
    const held = await db.chatQueuedMessage.findMany({ where: { sessionId: session, status: 'failed' } })
    expect(held.length).toBeGreaterThan(0)
    for (const id of ids) {
      const task = await db.backgroundTask.findUnique({ where: { id } })
      expect(task.consumed).toBe(false)
      expect(task.heldUntil).toBeTruthy()
    }

    // Lifting the pause hands the held tasks back (the sweep does this on its next tick).
    await setWorkspacePause(seed.workspaceId, null)
    await tasks.sweepUnnotifiedWakes()
    await drain(session)

    expect(await persistedWakes(session)).toHaveLength(1)
    const wakes = await persistedWakes(session)
    expect(wakes[0]!.ids.sort()).toEqual([...ids].sort())
    for (const id of ids) {
      expect((await db.backgroundTask.findUnique({ where: { id } })).consumed).toBe(true)
    }
  })

  test('AC9: two starters racing the same rows start one turn and deliver every task once', async () => {
    const session = await newSession()
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })

    await Promise.all([dispatchNext(session), dispatchNext(session)])
    await drain(session)

    expect(dispatched).toHaveLength(1)
    const delivered = (await persistedWakes(session)).flatMap((wake) => wake.ids)
    expect(delivered.sort()).toEqual([...ids].sort())
    expect(await queuedRows(session)).toHaveLength(0)
  })

  test('AC9b: a person pressing Send now on one wake while the drain runs does not deliver a task twice', async () => {
    const session = await newSession()
    const ids = await finishMany(session, ['a', 'b', 'c'])
    tasks._testing.clearTimers()
    await tasks.enqueueTaskWake(session, { dispatch: false })
    const rows = await queuedRows(session)
    const second = rows[1]!.id

    await Promise.all([dispatchNext(session), dispatchQueuedRow(session, second)])
    await drain(session)

    const delivered = (await persistedWakes(session)).flatMap((wake) => wake.ids)
    expect(delivered.sort()).toEqual([...ids].sort())
    expect(new Set(delivered).size).toBe(3)
    expect(await queuedRows(session)).toHaveLength(0)
  })
})
