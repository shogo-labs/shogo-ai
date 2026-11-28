// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-369 acceptance, QA's half: AC5 — the hand-off chain still works, and the
 * new delivery contract keeps it alive.
 *
 * The dev's suite (`sho-369-card-watch-wake-once`) proves the three fixed
 * defects on a single milestone. This one drives the chain the card actually
 * walks — In Development → QA & Review → PR Open → Done — and the two arms of
 * AC5 that only fire when a wake is *not* delivered as queued:
 *
 *  - a wake dropped as too old re-arms the watch (the person hears nothing, the
 *    card is still watched),
 *  - a wake held by a workspace pause does not re-arm it (the update is still
 *    owed, so arming here would be the duplicate bug again),
 *  - and after the card closes, nothing wakes the watcher again.
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

/**
 * A watched card in an active lane, assigned to this project's agent, with a
 * watcher session in a project that belongs to the seeded workspace — the pause
 * arm of AC5 needs a session whose workspace can be found.
 */
async function watchedCard() {
  const name = `qa369-${++n}`
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
      { name: 'Done', category: 'done' },
    ],
  })
  const card = await agent('POST', `/agent-boards/${board.json.board.slug}/items`, {
    title: 'Hand-off chain',
    assignee_agent: `project:${seed.projectId}`,
  })
  const item = await db.workItem.findUnique({ where: { id: card.json.item.id } })
  const session = await db.chatSession.create({
    data: {
      inferredName: 'Watches the card',
      workspaceId: seed.workspaceId,
      contextType: 'project',
      contextId: watcher,
      createdByUserId: seed.owner,
    },
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

const wakesFor = (watchId: string) => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(watchId))

const queuedFor = (sessionId: string, taskId: string, status?: string) =>
  db.chatQueuedMessage.findMany({ where: { sessionId, kind: 'task_notification', ...(status ? { status } : {}) } })
    .then((rows: any[]) => rows.filter((row) => tasks.taskWakeIdsFromBody(row.body).includes(taskId)))

/** Queue the wake without letting the dispatcher start a turn. */
async function queueWake(sessionId: string) {
  tasks._testing.clearTimers()
  return tasks.enqueueTaskWake(sessionId, { dispatch: false })
}

/** The milestone the holder's lane reports when it runs on the card and leaves it. */
async function stopOn(card: { item: any }, column: string, i = 1) {
  const { recordEvent } = await import('../services/work-boards.service')
  await recordEvent(card.item, 'agent_stopped', { agentRef: `project:${seed.projectId}` }, {
    column,
    messageId: `chain-stop-${i}`,
    assigneeAgentRef: `project:${seed.projectId}`,
  })
}

async function setWorkspacePaused(paused: boolean) {
  const settings = await import('../lib/workspace-settings')
  const pause = await import('../services/workspace-pause.service')
  const ws = await db.workspace.findUnique({ where: { id: seed.workspaceId }, select: { settings: true } })
  const current = settings.parseWorkspaceSettings(ws?.settings) ?? {}
  const next = { ...current, agentsPaused: paused ? { at: new Date().toISOString(), by: null } : null }
  await db.workspace.update({
    where: { id: seed.workspaceId },
    data: { settings: settings.encodeWorkspaceSettingsForWrite(next) as any },
  })
  pause.resetWorkspacePauseCache()
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  watcher = (await db.project.create({ data: { name: 'Assigner', workspaceId: seed.workspaceId } })).id
})

afterEach(async () => {
  tasks._testing.clearTimers()
  dispatched.length = 0
  await setWorkspacePaused(false)
})

afterAll(async () => {
  tasks._testing.clearTimers()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-369 · the hand-off chain wakes once per milestone (AC5)', () => {
  test('a stop, then Lane → QA → PR Open → Done: one update per milestone, and the watch closes at Done', async () => {
    const c = await watchedCard()

    // 1. The holder's lane runs on the card and stops without moving it.
    await stopOn(c, 'In Development')
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    expect(await queueWake(c.session.id)).toBe(true)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(wakesFor(c.watchId)).toHaveLength(1)
    expect(String(wakesFor(c.watchId)[0]!.text)).toContain('agent stopped with the card still in In Development')
    // Delivered, so the watch is watching again — for the whole rest of the card.
    const armed = (await tasks.getTask(c.watchId))!
    expect(armed.status).toBe('running')
    expect(armed.consumed).toBe(false)

    // 2. QA & Review is active, not a wake point: no update, watch untouched.
    await c.move('QA & Review')
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')
    expect(await queueWake(c.session.id)).toBe(false)

    // 3. PR Open is the review milestone: exactly one block, carrying only it.
    await c.move('PR Open')
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    expect(await queueWake(c.session.id)).toBe(true)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(wakesFor(c.watchId)).toHaveLength(2)
    const review = String(wakesFor(c.watchId)[1]!.text)
    expect(review.match(/\[Task update\]/g) ?? []).toHaveLength(1)
    expect(review).toContain('moved to PR Open (review)')
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')

    // 4. Done closes the watch: one last update, then nothing is armed.
    await c.move('Done')
    expect(await queueWake(c.session.id)).toBe(true)
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(wakesFor(c.watchId)).toHaveLength(3)
    expect(String(wakesFor(c.watchId)[2]!.text)).toContain('moved to Done (done)')

    const closed = (await tasks.getTask(c.watchId))!
    expect(closed.status).toBe('completed')
    expect(closed.consumed).toBe(true)
    // The chain ends here: no row left, no sweep, no wake.
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(0)
    expect(await queueWake(c.session.id)).toBe(false)
    expect(await dispatchNext(c.session.id)).toBe(false)
    expect(await tasks.sweepUnnotifiedWakes()).toBe(0)
    expect(wakesFor(c.watchId)).toHaveLength(3)
  }, 30_000)

  test('a wake dropped as too old re-arms the watch, and the next milestone still wakes it', async () => {
    const c = await watchedCard()

    await stopOn(c, 'In Development')
    expect(await queueWake(c.session.id)).toBe(true)
    expect(await queuedFor(c.session.id, c.watchId)).toHaveLength(1)

    // Six hours is the age at which the drain refuses to spend a turn on it.
    await db.chatQueuedMessage.updateMany({
      where: { sessionId: c.session.id, kind: 'task_notification' },
      data: { createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
    })
    expect(await dispatchNext(c.session.id)).toBe(false)
    // The person hears nothing about the dead update…
    expect(wakesFor(c.watchId)).toHaveLength(0)
    // …but the card is still watched: dropping a wake must not end the watch.
    const afterDrop = (await tasks.getTask(c.watchId))!
    expect(afterDrop.status).toBe('running')
    expect(afterDrop.consumed).toBe(false)

    // And it is live: the next milestone is delivered once.
    await c.move('PR Open')
    expect((await tasks.getTask(c.watchId))!.status).toBe('completed')
    expect(await queueWake(c.session.id)).toBe(true)
    expect(await dispatchNext(c.session.id)).toBe(true)
    expect(wakesFor(c.watchId)).toHaveLength(1)
    expect(String(wakesFor(c.watchId)[0]!.text)).toContain('moved to PR Open (review)')
  }, 30_000)

  test('a wake held by a workspace pause does not re-arm the watch, and is delivered once when the pause lifts', async () => {
    const c = await watchedCard()

    await stopOn(c, 'In Development')
    expect(await queueWake(c.session.id)).toBe(true)

    await setWorkspacePaused(true)
    expect(await dispatchNext(c.session.id)).toBe(false)

    // Held, not delivered: the wake is still owed, so arming here would settle
    // this same row again on the next event — the duplicate bug in a new coat.
    const held = (await tasks.getTask(c.watchId))!
    expect(held.status).toBe('completed')
    expect(held.consumed).toBe(false)
    expect(held.notifiedAt).not.toBeNull()
    expect(held.heldUntil?.getTime()).toBe(held.expiresAt.getTime())
    expect(wakesFor(c.watchId)).toHaveLength(0)

    // The pause lifts: the held update is handed back and delivered exactly once.
    // The failed row is the pause marker the person sees, not a second update.
    await setWorkspacePaused(false)
    expect(await tasks.sweepUnnotifiedWakes()).toBe(1)
    expect(await queuedFor(c.session.id, c.watchId, 'pending')).toHaveLength(1)
    expect(await queuedFor(c.session.id, c.watchId, 'failed')).toHaveLength(1)
    expect(await dispatchNext(c.session.id)).toBe(true)
    await waitFor(async () => wakesFor(c.watchId).length === 1)
    expect(wakesFor(c.watchId)).toHaveLength(1)
    expect(String(wakesFor(c.watchId)[0]!.text)).toContain('agent stopped with the card still in In Development')
    expect(await dispatchNext(c.session.id)).toBe(false)
    expect((await tasks.getTask(c.watchId))!.status).toBe('running')
  }, 30_000)
})
