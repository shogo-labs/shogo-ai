// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-196 acceptance (QA), the API half: a runtime notice is a *local* task's
 * completion. For a row the API owns (`work_item`, `project_call`,
 * `agent_reply`) the notice is never its to write, and a second notice for a
 * local task in the state it already reported is a replay.
 *
 * The dev's replay test walks a card through `emitTaskEvent`; these assertions
 * pin the gate itself, across every API-owned source, and prove it does not
 * drop a legitimate local completion on the way.
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
const bus = await import('../lib/conversation-bus')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api/internal', runtimeInternalRoutes({
  authenticate: async (c: any) => {
    const raw = c.req.header('x-identity')
    return raw ? JSON.parse(raw) : null
  },
  saveAgentAvatar: async () => ({}) as any,
  metalWorkspaceMember: (async () => null) as any,
} as any))

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const asProject = (projectId: string) => ({ 'x-identity': JSON.stringify({ kind: 'project', projectId }) })

const newSession = () => db.chatSession.create({
  data: { inferredName: 'SHO-196', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
})

/** A row the API itself is watching, re-armed and waiting for the next milestone. */
async function ownedRow(source: string, chatSessionId: string) {
  const id = tasks.newTaskId()
  await db.backgroundTask.create({
    data: {
      id,
      chatSessionId,
      source,
      targetRef: 'sho-196-ref',
      title: 'SHO-196',
      status: 'running',
      output: 'moved to In Development (active)',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  return id
}

const notice = (chatSessionId: string, id: string, source: string, text: string) => ({
  chatSessionId,
  tasks: [{ id, source, title: 'SHO-196', status: 'completed', text }],
})

const STALE = '[Task update] SHO-196 (t_stale) completed.\nLast output:\nmoved to QA & Review (active)'

const queuedWakes = (sessionId: string) =>
  db.chatQueuedMessage.findMany({
    where: { sessionId, kind: 'task_notification' },
    orderBy: { position: 'asc' },
  })

/** The wakes the API actually dispatched to the runtime for one task. */
const wakesFor = (id: string) => dispatched.filter((body) => (body.taskNotification?.taskIds ?? []).includes(id))

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

describe('SHO-196 · a runtime notice never writes a row the API owns', () => {
  test('every API-owned source is ignored, and its row keeps watching', async () => {
    const session = await newSession()
    for (const source of ['work_item', 'project_call', 'agent_reply']) {
      const id = await ownedRow(source, session.id)

      const res = await call('POST', '/internal/tasks/notify', notice(session.id, id, source, STALE), asProject(seed.projectId))

      expect(res.status).toBe(200)
      expect(res.json.queued).toBe(false)
      const row = await tasks.getTask(id)
      // Not finished, not delivered, not rewritten: the API still owns the wake.
      expect(row!.status).toBe('running')
      expect(row!.note).toBeNull()
      expect(row!.consumed).toBe(false)
      expect(row!.notifiedAt).toBeNull()
      expect(row!.output).toBe('moved to In Development (active)')
    }

    // A turn end has nothing to hand over for any of them.
    await tasks.enqueueTaskWake(session.id)
    expect(await queuedWakes(session.id)).toHaveLength(0)
  }, 20_000)
})

describe('SHO-196 · a local task is delivered once, with its own text', () => {
  test('a replay in the same state neither rewrites the row nor wakes again', async () => {
    const session = await newSession()
    const id = tasks.newTaskId()
    const first = '[Task update] bun test (x) completed.\nLast output:\n1 pass'
    const replay = '[Task update] bun test (x) completed.\nLast output:\nSTALE milestone'

    const created = await call('POST', '/internal/tasks/notify', notice(session.id, id, 'shell', first), asProject(seed.projectId))
    expect(created.json.queued).toBe(true)
    await waitFor(async () => wakesFor(id)[0], 10_000)

    const again = await call('POST', '/internal/tasks/notify', notice(session.id, id, 'shell', replay), asProject(seed.projectId))
    expect(again.json.queued).toBe(false)

    const row = await tasks.getTask(id)
    expect(row!.status).toBe('completed')
    expect(row!.note).toBe(first)

    // The next turn end finds nothing to deliver: the replay was dropped, not queued.
    await tasks.enqueueTaskWake(session.id)
    await new Promise((r) => setTimeout(r, 300))
    expect(wakesFor(id)).toHaveLength(1)
  }, 20_000)

  test('a local completion the API has not seen yet still wakes the session', async () => {
    const session = await newSession()
    const id = tasks.newTaskId()
    const text = '[Task update] bun test (y) completed.\nLast output:\n2 pass'

    const res = await call('POST', '/internal/tasks/notify', notice(session.id, id, 'shell', text), asProject(seed.projectId))
    expect(res.json.queued).toBe(true)

    const wake = await waitFor(async () => wakesFor(id)[0], 10_000)
    expect(String(wake.text)).toContain('2 pass')
    expect((await tasks.getTask(id))!.note).toBe(text)
  }, 20_000)
})
