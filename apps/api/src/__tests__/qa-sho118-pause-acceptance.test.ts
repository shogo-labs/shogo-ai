// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-118, criterion 3: "`agent_run_stop({ scope: 'workspace' })`
 * stops the running agents and holds new automatic runs (task updates,
 * schedules, triggers, card hand-offs, team-chat tags) until
 * `agent_run_stop({ resume: true })`; a person's own message still runs."
 *
 * `workspace-pause.test.ts` covers the queue (a task update), the schedule tick
 * and the route that sets the flag. The lane that actually ran during the
 * incident — a card hand-off waking a column's agent — enters through
 * `moveWorkItem` → `wakeAgent` → `runAgentReply`, which is a *different* entry
 * point, so it is driven here the way the board drives it: the real routes, the
 * real dispatcher, a real SQLite database.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.BETTER_AUTH_SECRET ||= 'qa-sho118-pause-test-secret'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const { workBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/work-boards.service')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const pause = await import('../services/workspace-pause.service')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')

const db = prisma as any
let seed: SeededWorkspace
let dev: string
let qa: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route(
  '/api/internal',
  agentChannelRoutes({
    authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId'), projectId: null }),
  } as any),
)

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'x-user': seed.member, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

/** The same route `agent_run_stop` calls. */
async function agentStop(body: unknown) {
  const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels/running-agents/stop`, {
    method: 'POST',
    headers: {
      'X-Requester-Ticket': signRequesterTicket({ projectId: workspaceTicketKey(seed.workspaceId), userId: seed.member }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

interface Run { projectId: string | null; prompt: string; release: (text: string) => void }
let calls: Run[] = []

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  dev = (await db.project.create({ data: { name: 'Dev', workspaceId: seed.workspaceId } })).id
  qa = (await db.project.create({ data: { name: 'QA', workspaceId: seed.workspaceId } })).id
  service.registerWorkBoardHooks()
})

beforeEach(async () => {
  calls = []
  dispatcher._resetDispatcherForTests()
  await db.agentWake.deleteMany({})
  pause.resetWorkspacePauseCache()
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 60_000,
    stopRuntimeTurn: async () => {},
    invoke: (args) =>
      new Promise<Response>((resolve) => {
        calls.push({
          projectId: args.projectId,
          prompt: args.prompt,
          release: (text) =>
            resolve(
              sseResponse([
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: text },
                { type: 'finish' },
              ]),
            ),
        })
      }),
  })
})

afterEach(async () => {
  pause.resetWorkspacePauseCache()
  await pause.setWorkspacePause(seed.workspaceId, null).catch(() => {})
  pause.resetWorkspacePauseCache()
  dispatcher._resetDispatcherForTests()
})

afterAll(async () => {
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  await db.agentWake.deleteMany({})
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** A board whose "In Development" column hands the card to the QA agent. */
async function board(name: string) {
  const channel = (await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name })).json.conversation
  const created = await call('POST', `/workspaces/${seed.workspaceId}/boards`, {
    conversationId: channel.id,
    name,
    columns: [
      { name: 'Planning', category: 'backlog' },
      { name: 'In Development', category: 'active', agentRef: `project:${qa}` },
      { name: 'Done', category: 'done' },
    ],
  })
  expect(created.status).toBe(201)
  return created.json.board
}

async function cardOn(b: any, title: string) {
  const created = await call('POST', `/boards/${b.id}/items`, { title, column: 'Planning' })
  expect(created.status).toBe(201)
  return created.json.item
}

const move = (b: any, card: any, column: string) => call('POST', `/work-items/${card.id}/move`, { column })
const runsOf = (key: string) => calls.filter((c) => c.prompt.includes(`work_item_get("${key}")`))

describe('the card lane during a pause', () => {
  test('a card hand-off is held, not lost, and runs on resume', async () => {
    const b = await board('pause-held')
    const card = await cardOn(b, 'Ship the kernel')

    const paused = await agentStop({ scope: 'workspace', reason: 'stop every lane' })
    expect(paused.status).toBe(200)
    expect(paused.json.paused).toMatchObject({ reason: 'stop every lane' })
    pause.resetWorkspacePauseCache()

    // The move is what woke Build Engineer and QA in the incident.
    expect((await move(b, card, 'In Development')).status).toBe(200)

    // Held: no run, and the hold is a durable row rather than a retry loop.
    await new Promise((r) => setTimeout(r, 1_200))
    expect(runsOf(card.key)).toHaveLength(0)
    const wakes = await db.agentWake.findMany({ where: { threadRootId: card.threadRootMessageId } })
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ reason: 'paused', status: 'pending', agentRef: `project:${qa}` })

    // Nothing is dropped on resume: the same card runs, once.
    const lifted = await agentStop({ scope: 'workspace', resume: true })
    expect(lifted.status).toBe(200)
    expect(lifted.json).toMatchObject({ paused: null, resumed: true })
    const run = await waitFor(() => (runsOf(card.key).length ? runsOf(card.key)[0]! : null), 15_000)
    expect(run.projectId).toBe(qa)
    expect(runsOf(card.key)).toHaveLength(1)
    await waitFor(async () => (await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId, status: 'pending' } })) === 0, 10_000)
    run.release('On it.')
  }, 40_000)

  test("a person's own tag still runs while paused", async () => {
    const b = await board('pause-person')
    const channelId = b.conversationId
    await agentStop({ scope: 'workspace' })
    pause.resetWorkspacePauseCache()

    const posted = await call('POST', `/conversations/${channelId}/messages`, { text: `<@a:p:${dev}> one more look` })
    expect(posted.status).toBe(201)

    const run = await waitFor(() => (calls.find((c) => c.projectId === dev) ?? null), 15_000)
    expect(run.prompt).toContain('one more look')
    run.release('Looking.')
  }, 30_000)

  test('a paused workspace reports nothing running and the pause itself', async () => {
    await agentStop({ scope: 'workspace', reason: 'hold everything' })
    pause.resetWorkspacePauseCache()
    const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels/running-agents`, {
      headers: { 'X-Requester-Ticket': signRequesterTicket({ projectId: workspaceTicketKey(seed.workspaceId), userId: seed.member }) },
    })
    const json = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(json.runs).toEqual([])
    expect(json.paused).toMatchObject({ reason: 'hold everything' })
  })
})
