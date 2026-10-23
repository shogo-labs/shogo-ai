// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-129 acceptance, against a real SQLite database and the real routes.
 *
 * The bug: one mention in a card thread produced twelve runs. The agent the
 * card is assigned to also *watches* it, so its own run ending settled that
 * watch, the wake re-armed the same row, the next run ended the same way, and
 * nothing new ever entered the loop.
 *
 * Three things are read the way production reads them:
 *
 * 1. Twelve runs ending on the card — through `noteCardRunEnded`, the seam the
 *    runtime reports a run end at — wake nobody and leave one watch still armed.
 *    The note itself still lands in the card thread: it is the *wake* that must
 *    not happen.
 * 2. A different agent stopping on the same card still wakes the watcher: that is
 *    the hand-off watch's whole purpose, and the fix must not take it away.
 * 3. The backstop reaches the cap in the order production runs it — settle,
 *    `enqueueTaskWake` (which re-arms the row), then the cap being measured —
 *    because the row is cleared on re-arm and a count read off the row can never
 *    see the repeat.
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
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const asProject = (projectId: string) => ({ 'x-identity': JSON.stringify({ kind: 'project', projectId }) })

/** The pattern the runtime hands the API when an agent is handed a card. */
const HANDOFF_UNTIL = 'moved to [^\\n]*\\((review|waiting|done|dismissed)\\)|(^|\\n)agent (stopped|failed)'

let n = 0

/**
 * A card assigned to this project's agent, sitting in `QA & Review`, watched by
 * a session of that *same* agent — the watch the agent holds on the card it was
 * handed, which is the one that used to keep waking itself.
 */
async function watchedCard() {
  const name = `sho129-${++n}`
  await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name }, { 'x-user': seed.member })
  const agent = (method: string, path: string, body?: unknown) =>
    call(method, `/internal/workspaces/${seed.workspaceId}${path}`, body, { 'x-project': seed.projectId })
  const board = await agent('POST', '/agent-boards', {
    channel: `#${name}`,
    name,
    columns: [
      { name: 'In Development', category: 'active' },
      { name: 'QA & Review', category: 'active' },
      { name: 'Done', category: 'done' },
    ],
  })
  const card = await agent('POST', `/agent-boards/${board.json.board.slug}/items`, {
    title: 'Wake loop',
    assignee_agent: `project:${seed.projectId}`,
  })
  await agent('POST', `/agent-work-items/${card.json.item.key}/move`, { column: 'QA & Review' })
  const item = await db.workItem.findUnique({ where: { id: card.json.item.id } })
  const session = await db.chatSession.create({
    data: { inferredName: 'Holds the card', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
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
  return { item, session, watchId, key: card.json.item.key as string }
}

/** The wakes the API actually dispatched for one watch. */
const wakesFor = (watchId: string) => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(watchId))

/** A wake message the dispatcher would have written, for the count to read. */
async function wakeMessage(sessionId: string, taskId: string) {
  const parts = JSON.stringify([{ type: 'text', text: '[Task update] x' }, { type: 'data-task-notification', data: { taskIds: [taskId] } }])
  await db.chatMessage.create({ data: { sessionId, role: 'user', content: '[Task update] x', parts, agent: 'technical' } })
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

describe('SHO-129 · a run ending on a card does not wake the agent that just ran', () => {
  test('twelve run-ends wake nobody, queue nothing, and leave the watch armed', async () => {
    const c = await watchedCard()
    const { noteCardRunEnded } = await import('../services/work-boards.service')

    for (let i = 0; i < 12; i++) {
      await noteCardRunEnded({
        threadRootId: c.item.threadRootMessageId,
        projectId: seed.projectId,
        messageId: `run-${i}`,
        agentStatus: 'done',
      })
    }

    const row = (await tasks.getTask(c.watchId))!
    // Still watching the card, and still the same single row for its whole life.
    expect(row.status).toBe('running')
    expect(row.id).toBe(c.watchId)
    expect(row.output ?? '').not.toContain('agent stopped')
    // Nothing was queued and nothing reached the runtime: no wake, so no run.
    expect(await tasks.enqueueTaskWake(c.session.id)).toBe(false)
    expect(wakesFor(c.watchId)).toHaveLength(0)
    expect(await tasks.consecutiveWakeWaits(c.session.id, tasks.MAX_CONSECUTIVE_CARD_WAKES)).toBe(0)
    // The note itself did land in the card thread — the loop is gone, the news is not.
    await waitFor(async () => (await db.workItemEvent.count({ where: { workItemId: c.item.id, type: 'agent_stopped' } })) > 0)
  })

  test('another agent stopping on the same card still wakes the watcher', async () => {
    const c = await watchedCard()
    const { recordEvent } = await import('../services/work-boards.service')
    const other = await db.project.create({ data: { name: `Reviewer ${++n}`, workspaceId: seed.workspaceId } })

    await recordEvent(c.item, 'agent_stopped', { agentRef: `project:${other.id}` }, { column: 'QA & Review' })

    const wake = await waitFor(async () => wakesFor(c.watchId)[0], 10_000)
    expect(wake.text).toContain('agent stopped with the card still in QA & Review')
    // The watch survives the milestone: it re-arms for the rest of the card's life.
    await waitFor(async () => (await tasks.getTask(c.watchId))!.status === 'running', 10_000)
    expect((await tasks.getTask(c.watchId))!.id).toBe(c.watchId)
  })
})

describe('SHO-129 · the cap is measured after the re-arm, so it can see the repeat', () => {
  test('a card watch that keeps re-arming reaches the card cap', async () => {
    const c = await watchedCard()
    const other = await db.project.create({ data: { name: `Milestone ${++n}`, workspaceId: seed.workspaceId } })

    // Exactly the order the coalesce timer runs: settle the watch, enqueue the
    // wake (which re-arms the row and clears its timestamps), then measure.
    for (let i = 0; i < 45; i++) {
      const { recordEvent } = await import('../services/work-boards.service')
      await recordEvent(c.item, 'agent_stopped', { agentRef: `project:${other.id}` }, { column: 'QA & Review', messageId: `ms-${i}` })
      await waitFor(async () => (await tasks.getTask(c.watchId))!.status === 'completed', 5_000)
      await tasks.enqueueTaskWake(c.session.id, { dispatch: false })
      const armed = (await tasks.getTask(c.watchId))!
      expect(armed.status).toBe('running')
      expect(armed.finishedAt).toBeNull()
      await wakeMessage(c.session.id, c.watchId)
    }

    const waits = await tasks.consecutiveWakeWaits(c.session.id, tasks.MAX_CONSECUTIVE_CARD_WAKES)
    expect(waits).toBeGreaterThan(tasks.MAX_CONSECUTIVE_CARD_WAKES)
  })

  test('three tasks that were already running, finishing one at a time, are still one wait', async () => {
    const session = await db.chatSession.create({
      data: { inferredName: 'Runs three things', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
    })
    const ids = [tasks.newTaskId(), tasks.newTaskId(), tasks.newTaskId()]
    for (const [i, id] of ids.entries()) {
      await tasks.createTask({ id, chatSessionId: session.id, source: 'agent_reply', targetRef: `reply-${i}:ws`, title: `@Ops reply ${i}` })
    }
    for (const [i, id] of ids.entries()) {
      await new Promise((r) => setTimeout(r, 20))
      await tasks.emitTaskEvent('agent_reply', `reply-${i}:ws`, { status: 'completed', line: `reply ${i} done` })
      await tasks.enqueueTaskWake(session.id, { dispatch: false })
      await wakeMessage(session.id, id)
    }
    expect(await tasks.consecutiveWakeWaits(session.id, tasks.MAX_CONSECUTIVE_WAKES)).toBe(1)
  })
})
