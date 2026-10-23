// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-118: "pause every agent lane" had nothing to make it stick.
 *
 * `agent_run_stop` stopped one run or one thread, while task updates,
 * schedules, triggers, card hand-offs and team-chat tags kept starting runs.
 * The pause lives in `Workspace.settings.agentsPaused` (no schema change) and
 * is enforced at each automatic entry point. These tests drive the real
 * database, the real dispatcher and the real route:
 *
 *  - a wake is held while paused and delivered after the resume;
 *  - a person's own queued message still dispatches while paused;
 *  - a schedule due during the pause is not claimed (`nextRunAt` untouched);
 *  - `agent_run_stop({ scope: "workspace" })` sets the flag and `resume` lifts it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.BETTER_AUTH_SECRET ||= 'workspace-pause-test-secret'

const { dir } = setupChannelsTestDb()

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
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
const pause = await import('../services/workspace-pause.service')
const { agentChannelRoutes } = await import('../routes/conversations')
const { signRequesterTicket } = await import('../lib/requester-ticket')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
// The running-agents routes are the internal agent-channel surface, the same
// one `agent_runs_list` / `agent_run_stop` call.
app.route(
  '/api/internal',
  agentChannelRoutes({
    authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId'), projectId: undefined }),
  } as any),
)

const requesterTicket = (workspaceId: string, userId: string) =>
  signRequesterTicket({ projectId: `ws:${workspaceId}`, userId })

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** One finished, unseen task in the session — the shape every wake comes from. */
async function finishedTask(chatSessionId: string, label: string): Promise<string> {
  const id = tasks.newTaskId()
  await tasks.createTask({ id, chatSessionId, source: 'agent_reply', targetRef: `m:${label}`, title: `@Ops ${label}` })
  await tasks.emitTaskEvent('agent_reply', `m:${label}`, { status: 'completed', line: 'done' })
  tasks._testing.clearTimers()
  return id
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(async () => {
  tasks._testing.clearTimers()
  dispatched.length = 0
  pause.resetWorkspacePauseCache()
  await pause.setWorkspacePause(seed.workspaceId, null).catch(() => {})
  pause.resetWorkspacePauseCache()
})

afterAll(async () => {
  tasks._testing.clearTimers()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('the pause flag', () => {
  test('is stored in workspace settings, so there is no schema change to keep in step', async () => {
    expect(await pause.readWorkspacePause(seed.workspaceId)).toBeNull()
    const set = await pause.setWorkspacePause(seed.workspaceId, { at: '2026-10-21T07:19:00.000Z', by: seed.owner, reason: 'stop everything' })
    expect(set).toEqual({ at: '2026-10-21T07:19:00.000Z', by: seed.owner, reason: 'stop everything' })
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(true)

    const row = await db.workspace.findUnique({ where: { id: seed.workspaceId }, select: { settings: true } })
    const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
    expect(settings.agentsPaused).toMatchObject({ by: seed.owner, reason: 'stop everything' })

    await pause.setWorkspacePause(seed.workspaceId, null)
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(false)
  })

  test('does not leak into another workspace', async () => {
    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner })
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.otherWorkspaceId)).toBe(false)
  })
})

describe('while paused', () => {
  test('a task update is held at the source and delivered after the resume', async () => {
    const chatSessionId = await newSession()
    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner })

    const taskId = await finishedTask(chatSessionId, 'held')
    expect(await tasks.enqueueTaskWake(chatSessionId, { dispatch: false })).toBe(false)
    expect(await db.chatQueuedMessage.count({ where: { sessionId: chatSessionId } })).toBe(0)
    await dispatchNext(chatSessionId)
    expect(dispatched).toHaveLength(0)

    // Nothing was lost: the task is still finished-and-unseen.
    const task = await tasks.getTask(taskId)
    expect(task).toMatchObject({ status: 'completed', consumed: false, notifiedAt: null })

    await pause.resumeWorkspaceAgents(seed.workspaceId)
    await waitFor(async () => dispatched.length > 0)
    expect(dispatched[0].taskNotification).toEqual({ taskIds: [taskId] })
  })

  test("a person's own message still dispatches", async () => {
    const chatSessionId = await newSession()
    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner })
    await db.chatQueuedMessage.create({
      data: {
        sessionId: chatSessionId,
        userId: seed.owner,
        position: 0,
        status: 'pending',
        kind: 'user',
        content: 'carry on with the billing fix',
        parts: JSON.stringify([{ type: 'text', text: 'carry on with the billing fix' }]),
        body: JSON.stringify({ text: 'carry on with the billing fix' }),
      },
    })
    expect(await dispatchNext(chatSessionId)).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].text).toBe('carry on with the billing fix')
  })

  test('a queued automatic wake is held rather than retried', async () => {
    const chatSessionId = await newSession()
    const taskId = await finishedTask(chatSessionId, 'queued')
    // Queued before the pause landed.
    expect(await tasks.enqueueTaskWake(chatSessionId, { dispatch: false })).toBe(true)

    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner })
    expect(await dispatchNext(chatSessionId)).toBe(false)
    expect(dispatched).toHaveLength(0)

    const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: chatSessionId } })
    expect(row.status).toBe('failed')
    expect(row.error).toBe(tasks.WAKE_WORKSPACE_PAUSED)
    expect(JSON.parse(row.body).taskNotification.paused).toBe(true)

    // The composer shows it as held work, not as a message that failed.
    const state = await tasks.sessionWakeState(chatSessionId)
    expect(state.waiting.map((wait: any) => wait.taskId)).toEqual([taskId])
    expect(state.paused).toBe(true)
  })

  test('a due schedule is not claimed and keeps its nextRunAt', async () => {
    const schedule = await db.agentSchedule.create({
      data: {
        workspaceId: seed.workspaceId,
        userId: seed.owner,
        name: 'nightly digest',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        prompt: 'summarise',
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000),
      },
    })
    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner })

    const { dispatchDueSchedules } = await import('../jobs/run-agent-schedule-dispatch')
    await dispatchDueSchedules({} as any)

    const after = await db.agentSchedule.findUnique({ where: { id: schedule.id } })
    expect(after.lastRunAt).toBeNull()
    expect(after.runningAt).toBeNull()
    expect(new Date(after.nextRunAt).getTime()).toBe(new Date(schedule.nextRunAt).getTime())
  })
})

describe('agent_run_stop', () => {
  const stop = (body: unknown, userId = seed.owner) =>
    call('POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/running-agents/stop`, body, {
      'X-Requester-Ticket': requesterTicket(seed.workspaceId, userId),
    })

  test('scope "workspace" pauses automatic starts, and resume lifts it', async () => {
    const set = await stop({ scope: 'workspace', reason: 'stop every lane' })
    expect(set.status).toBe(200)
    expect(set.json.paused).toMatchObject({ by: seed.owner, reason: 'stop every lane' })
    expect(set.json.resumed).toBe(false)
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(true)

    const lifted = await stop({ scope: 'workspace', resume: true })
    expect(lifted.status).toBe(200)
    expect(lifted.json).toMatchObject({ paused: null, resumed: true })
    pause.resetWorkspacePauseCache()
    expect(await pause.isWorkspaceAgentsPaused(seed.workspaceId)).toBe(false)
  })

  test('agent_runs_list reports the pause alongside the runs', async () => {
    await pause.setWorkspacePause(seed.workspaceId, { at: new Date().toISOString(), by: seed.owner })
    const listed = await call('GET', `/internal/workspaces/${seed.workspaceId}/agent-channels/running-agents`, undefined, {
      'X-Requester-Ticket': requesterTicket(seed.workspaceId, seed.owner),
    })
    expect(listed.status).toBe(200)
    expect(listed.json.runs).toEqual([])
    expect(listed.json.paused).toMatchObject({ by: seed.owner })
  })

  test('a stop without a scope still requires a target', async () => {
    const bare = await stop({})
    expect(bare.status).toBe(400)
    expect(bare.json.error.code).toBe('invalid_input')
  })
})
