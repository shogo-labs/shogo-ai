// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-196 acceptance, against a real SQLite database and the real routes.
 *
 * The bug: a finished card watch's `[Task update]` reached the watching chat
 * 15+ times, every 4–8 s, each copy carrying the *old* milestone text. The
 * runtime had evicted the task entry but kept its completion note, so the note
 * failed every ownership guard and was POSTed to `/tasks/notify` as a local
 * task. The API then upserted its own re-armed `work_item` row to `completed`
 * with that stale note, which woke the session again — and the turn end
 * re-queued the next copy.
 *
 * This test replays exactly that shape: one card watch walks QA & Review →
 * Changes Requested → QA & Review → PR Open → Done, and after every wake the
 * runtime's stale notice for the same id is POSTed. What must hold:
 *
 * 1. One queued wake per transition the watch reports, carrying the milestone
 *    the card is actually on now.
 * 2. Zero wakes carrying the stale notice's text — the API owns a `work_item`
 *    row, so a runtime notice about it is never its to write.
 * 3. Zero wakes after the card reaches Done.
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

/** A watch that reports every move, so each transition is its own wake. */
const EVERY_MOVE = 'moved to [^\\n]*\\([a-z]+\\)'

let n = 0

/** A card assigned to this project's agent, watched by one of its sessions. */
async function watchedCard() {
  const name = `sho196-${++n}`
  await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name }, { 'x-user': seed.member })
  const agent = (method: string, path: string, body?: unknown) =>
    call(method, `/internal/workspaces/${seed.workspaceId}${path}`, body, { 'x-project': seed.projectId })
  const board = await agent('POST', '/agent-boards', {
    channel: `#${name}`,
    name,
    columns: [
      { name: 'In Development', category: 'active' },
      { name: 'QA & Review', category: 'active' },
      { name: 'Changes Requested', category: 'active' },
      { name: 'PR Open', category: 'review' },
      { name: 'Done', category: 'done' },
    ],
  })
  const card = await agent('POST', `/agent-boards/${board.json.board.slug}/items`, {
    title: 'Task update replay',
    assignee_agent: `project:${seed.projectId}`,
  })
  await agent('POST', `/agent-work-items/${card.json.item.key}/move`, { column: 'QA & Review' })
  const item = await db.workItem.findUnique({ where: { id: card.json.item.id } })
  const session = await db.chatSession.create({
    data: { inferredName: 'Watches the card', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  const watchId = tasks.newTaskId()
  const created = await call('POST', '/internal/tasks', {
    id: watchId,
    chatSessionId: session.id,
    source: 'work_item',
    targetRef: item.id,
    title: card.json.item.key,
    until: EVERY_MOVE,
  }, asProject(seed.projectId))
  expect(created.status).toBe(201)
  return { item, session, watchId, key: card.json.item.key as string }
}

/** The wakes the API actually dispatched for one watch. */
const wakesFor = (watchId: string) => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(watchId))

/** Move the card and wait for the wake the move owes the watcher. */
async function move(watch: Awaited<ReturnType<typeof watchedCard>>, column: string, category: string) {
  const before = wakesFor(watch.watchId).length
  await tasks.emitTaskEvent('work_item', watch.item.id, {
    line: `moved to ${column} (${category})`,
    card: { to: { column, category } },
  })
  tasks._testing.clearTimers()
  await tasks.enqueueTaskWake(watch.session.id)
  const wake = await waitFor(async () => wakesFor(watch.watchId)[before], 10_000)
  return wake as { text: string }
}

const staleNotice = (watch: { key: string; watchId: string }) =>
  `[Task update] ${watch.key} (${watch.watchId}) completed.\nLast output:\nmoved to In Development (active)`

/**
 * The exact POST the buggy runtime made once it had evicted the task entry: a
 * completion note frozen at an old milestone (`In Development`, hours ago), for
 * an id the API still owns and has already re-armed.
 */
async function replayStaleNotice(watch: Awaited<ReturnType<typeof watchedCard>>) {
  return call('POST', '/internal/tasks/notify', {
    chatSessionId: watch.session.id,
    tasks: [{
      id: watch.watchId,
      source: 'work_item',
      title: watch.key,
      status: 'completed',
      text: staleNotice(watch),
    }],
  }, asProject(seed.projectId))
}

/** Every task-notification row the session has queued, oldest first. */
const queuedWakes = (sessionId: string) =>
  db.chatQueuedMessage.findMany({
    where: { sessionId, kind: 'task_notification' },
    orderBy: { position: 'asc' },
  })

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

describe('SHO-196 · a stale runtime notice cannot replay a card update', () => {
  test('one wake per transition, the current milestone text, and nothing after Done', async () => {
    const watch = await watchedCard()
    const stale = staleNotice(watch)

    const walk = [
      { column: 'Changes Requested', category: 'active' },
      { column: 'QA & Review', category: 'active' },
      { column: 'PR Open', category: 'review' },
      { column: 'Done', category: 'done' },
    ]

    for (const [i, step] of walk.entries()) {
      const wake = await move(watch, step.column, step.category)
      // The wake reads the row's current output, not a snapshot the runtime took.
      expect(wake.text).toContain(`moved to ${step.column} (${step.category})`)
      expect(wake.text).not.toContain('In Development')

      // The runtime's stale notice for the same id arrives right after the wake.
      const replay = await replayStaleNotice(watch)
      expect(replay.status).toBe(200)
      expect(replay.json.queued).toBe(false)

      // Exactly one wake so far, and the row still carries the live milestone.
      expect(wakesFor(watch.watchId)).toHaveLength(i + 1)
      const row = (await tasks.getTask(watch.watchId))!
      expect(row.note).toBeNull()
    }

    // Four transitions, four wakes: no replay produced a fifth.
    const texts = wakesFor(watch.watchId).map((body) => String(body.text))
    expect(texts).toHaveLength(walk.length)
    expect(texts.filter((text) => text === stale)).toHaveLength(0)
    for (const [i, step] of walk.entries()) {
      expect(texts[i]).toContain(`moved to ${step.column} (${step.category})`)
    }
    // Each wake was delivered once and consumed: nothing is left sitting in the
    // queue for the next turn end to pick up.
    expect(await queuedWakes(watch.session.id)).toHaveLength(0)

    // The card is closed, so the watch is done: another stale notice and another
    // turn end must not wake anybody.
    await tasks.enqueueTaskWake(watch.session.id)
    await replayStaleNotice(watch)
    await tasks.enqueueTaskWake(watch.session.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(wakesFor(watch.watchId)).toHaveLength(walk.length)
    expect(await queuedWakes(watch.session.id)).toHaveLength(0)
  }, 30_000)

  test('a repeat notice for a local task in the same state is not delivered twice', async () => {
    const session = await db.chatSession.create({
      data: { inferredName: 'Runs a shell command', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
    })
    const id = tasks.newTaskId()
    const notice = (text: string) => ({
      chatSessionId: session.id,
      tasks: [{ id, source: 'shell', title: 'bun test', status: 'completed', text }],
    })

    const first = await call('POST', '/internal/tasks/notify', notice('[Task update] bun test (x) completed.'), asProject(seed.projectId))
    expect(first.json.queued).toBe(true)
    await waitFor(async () => (await wakesFor(id)).length === 1, 10_000)

    // The runtime re-sends the same completion: a local task finishes once.
    const again = await call('POST', '/internal/tasks/notify', notice('[Task update] bun test (x) completed.'), asProject(seed.projectId))
    expect(again.json.queued).toBe(false)
    await tasks.enqueueTaskWake(session.id)
    expect(wakesFor(id)).toHaveLength(1)
  }, 20_000)
})
