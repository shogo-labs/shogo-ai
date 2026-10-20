// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-76 acceptance, through the routes the app calls: one live run per
 * (agent, thread) — one running reply and one live invoke for a burst of
 * wakes, one visible ack per wake, every queued wake still runs, a Stop that
 * reaches only the reply it names, and `ChatSession.lastActiveAt` moving on a
 * tag, a chained hand-off and a card move.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'sho76-acceptance-test-secret'

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const { workBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')
const tasks = await import('../services/background-tasks.service')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let reviewer: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') ?? null }),
}))

const ticketFor = (userId: string) => signRequesterTicket({ projectId: workspaceTicketKey(seed.workspaceId), userId })

async function asAgent(method: string, path: string, opts: { requester?: string; body?: unknown } = {}) {
  const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels${path}`, {
    method,
    headers: {
      ...(opts.requester ? { 'X-Requester-Ticket': ticketFor(opts.requester) } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'x-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

interface Call {
  projectId: string | null
  sessionId: string
  prompt: string
  release: (text: string) => void
}

let calls: Call[] = []
let inFlight = 0
let maxInFlight = 0
let runtimeStops: Array<{ projectId: string | null; sessionId: string; userId: string }> = []

function answer(text: string) {
  return sseResponse([
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'finish' },
  ])
}

/** Every run blocks until the test releases it, so the next wake always meets a live one. */
function gateRuns() {
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 60_000,
    stopRuntimeTurn: async ({ projectId, sessionId, userId }) => { runtimeStops.push({ projectId, sessionId, userId }) },
    invoke: (args) => new Promise<Response>((resolve, reject) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        inFlight--
        fn()
      }
      calls.push({
        projectId: args.projectId,
        sessionId: args.sessionId,
        prompt: args.prompt,
        release: (text) => settle(() => resolve(answer(text))),
      })
      args.signal.addEventListener('abort', () => settle(() => reject(new Error('aborted'))), { once: true })
    }),
  })
}

const tag = (projectId: string) => `<@a:p:${projectId}>`

async function channel(name: string) {
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name,
    agents: [
      { projectId: builder, agentTrigger: 'mention' },
      { projectId: reviewer, agentTrigger: 'mention' },
    ],
    userEmails: [],
  })
  return ch.id as string
}

async function post(user: string, conversationId: string, text: string, threadRootId?: string): Promise<string> {
  const res = await app.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'x-user': user, 'Content-Type': 'application/json' },
    body: JSON.stringify(threadRootId ? { text, threadRootId } : { text }),
  })
  return (await res.json() as any).message.id as string
}

async function thread(threadRootId: string): Promise<any[]> {
  const rows = await db.conversationMessage.findMany({ where: { threadRootId }, orderBy: { seq: 'asc' } })
  return rows.map((row: any) => ({
    ...row,
    blocks: typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks,
  }))
}

const agentRows = (rows: any[]) => rows.filter((r) => r.authorType === 'agent' && r.authorAgentRef !== null)

/** The run for one agent, from `from` on: waits for the dispatcher to reach it. */
async function waitForCall(projectId: string, from = 0, timeoutMs = 20_000): Promise<Call & { index: number }> {
  return waitFor(async () => {
    const index = calls.slice(from).findIndex((c) => c.projectId === projectId)
    return index >= 0 ? { ...calls[from + index]!, index: from + index } : null
  }, timeoutMs)
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  reviewer = (await db.project.create({ data: { name: 'Reviewer', workspaceId: seed.workspaceId } })).id
})

beforeEach(() => {
  calls = []
  inFlight = 0
  maxInFlight = 0
  runtimeStops = []
  dispatcher._resetDispatcherForTests()
  gateRuns()
})

afterAll(async () => {
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  await db.agentWake.deleteMany({})
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('a burst of wakes while the agent is live', () => {
  test('leaves one running reply, one live invoke, and runs every wake it queued', async () => {
    const id = await channel('burst')
    const root = await post(seed.member, id, `${tag(builder)} build it`)
    await waitForCall(builder)

    // Four wakes at once, the way a busy thread delivers them.
    const burst = await Promise.all([1, 2, 3, 4].map((n) => post(seed.member, id, `${tag(builder)} follow-up ${n}`, root)))
    await new Promise((r) => setTimeout(r, 250))

    // One live invoke, never a second turn behind the first — then one running row.
    expect(inFlight).toBe(1)
    expect(maxInFlight).toBe(1)
    await waitFor(async () => (await db.agentWake.count({ where: { conversationId: id, status: 'pending' } })) === 4)
    const rows = await thread(root)
    expect(agentRows(rows).filter((r) => r.agentStatus === 'running')).toHaveLength(1)

    // What the agent-facing list reports: one run, not two.
    const listed = await asAgent('GET', `/running-agents?channel=burst&threadRootId=${root}`, { requester: seed.member })
    expect(listed.status).toBe(200)
    expect(listed.json.runs).toHaveLength(1)

    // Every wake is acknowledged in the thread, once each.
    const acks = rows.filter((r) => r.blocks?.wakeQueued)
    expect(acks).toHaveLength(4)
    expect(acks.map((a) => a.blocks.wakeQueued.triggerMessageId).sort()).toEqual([...burst].sort())

    // And none of them is dropped: each runs after the one before it settles.
    for (let n = 0; n < 5; n++) {
      const running = calls[n]!
      expect(inFlight).toBe(1)
      running.release(`Replied ${n}.`)
      if (n < 4) await waitFor(() => calls.length > n + 1, 5000)
    }

    const settled = await waitFor(async () => {
      const agents = agentRows(await thread(root))
      return agents.length === 5 && agents.every((r) => r.agentStatus === 'done') ? agents : null
    }, 10_000)
    expect(settled.map((r) => r.text)).toEqual(['Replied 0.', 'Replied 1.', 'Replied 2.', 'Replied 3.', 'Replied 4.'])
    expect(maxInFlight).toBe(1)
    expect((await db.agentWake.findMany({ where: { conversationId: id } })).map((w: any) => w.status)).toEqual(['done', 'done', 'done', 'done'])
  })
})

describe('the session activity stamp', () => {
  test('moves on a tag, on a chained hand-off, and on a card move', async () => {
    const id = await channel('stamp')
    const stale = () => new Date(Date.now() - 3_600_000)

    // A tag that starts a session.
    const root = await post(seed.member, id, `${tag(builder)} first look`)
    const first = await waitForCall(builder)
    first.release('Looked.')
    await waitFor(async () => (await thread(root)).some((r) => r.authorType === 'agent' && r.agentStatus === 'done'))

    // A tag that resumes it.
    const older = stale()
    await db.chatSession.update({ where: { id: first.sessionId }, data: { lastActiveAt: older } })
    await post(seed.member, id, `${tag(builder)} dig deeper`, root)
    const second = await waitForCall(builder, first.index + 1)
    expect(second.sessionId).toBe(first.sessionId)
    expect((await db.chatSession.findUnique({ where: { id: first.sessionId } })).lastActiveAt.getTime())
      .toBeGreaterThan(older.getTime())
    second.release('Deeper.')

    // A chained hand-off: the reviewer's own session resumes when builder tags it.
    await post(seed.member, id, `${tag(reviewer)} take a look`, root)
    const review = await waitForCall(reviewer, second.index + 1)
    review.release('Reviewed.')
    await waitFor(async () => (await thread(root)).some((r) => r.authorType === 'agent' && r.agentStatus === 'done' && r.authorAgentRef?.projectId === reviewer))
    const reviewStale = stale()
    await db.chatSession.update({ where: { id: review.sessionId }, data: { lastActiveAt: reviewStale } })
    await post(seed.member, id, `${tag(builder)} hand it to the reviewer`, root)
    const handoff = await waitForCall(builder, review.index + 1)
    handoff.release(`Handing to ${tag(reviewer)} now.`)
    const chained = await waitForCall(reviewer, handoff.index + 1)
    expect(chained.sessionId).toBe(review.sessionId)
    expect((await db.chatSession.findUnique({ where: { id: review.sessionId } })).lastActiveAt.getTime())
      .toBeGreaterThan(reviewStale.getTime())
    chained.release('On it.')

    // A card move: the agent it wakes resumes the card thread's session.
    const board = (await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/boards`, { conversationId: id, name: 'Stamp board' })).json.board
    const column = await call(seed.member, 'POST', `/boards/${board.id}/columns`, { name: 'Agent queue', category: 'active', agentRef: builder })
    expect(column.status).toBe(201)
    // No assignee: assigning would wake the agent by itself, and this part is about the move.
    const card = (await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Stamp card' })).json.item
    const cardRoot = card.threadRootMessageId as string
    await post(seed.member, id, `${tag(builder)} start on this card`, cardRoot)
    const started = await waitForCall(builder, chained.index + 1)
    started.release('Started.')
    await waitFor(async () => (await thread(cardRoot)).some((r) => r.authorType === 'agent' && r.agentStatus === 'done'))
    // Nothing is queued here, so the move below is a wake with nothing in front of it.
    await waitFor(async () => (await db.agentWake.count({ where: { conversationId: id } })) === 0, 5000)
    await new Promise((r) => setTimeout(r, 150))
    const cardStale = stale()
    await db.chatSession.update({ where: { id: started.sessionId }, data: { lastActiveAt: cardStale } })

    expect((await call(seed.member, 'POST', `/work-items/${card.id}/move`, { column: 'Agent queue' })).status).toBe(200)
    const moved = await waitForCall(builder, started.index + 1)
    expect(moved.sessionId).toBe(started.sessionId)
    expect((await db.chatSession.findUnique({ where: { id: started.sessionId } })).lastActiveAt.getTime())
      .toBeGreaterThan(cardStale.getTime())
    moved.release('Moved.')

    const sessions = [first.sessionId, review.sessionId, started.sessionId]
    await waitFor(async () => {
      const live = await db.conversationMessage.count({ where: { agentSessionId: { in: sessions }, agentStatus: 'running' } })
      return live === 0
    }, 5000)
  })
})

describe('a Stop that names one reply', () => {
  test('ends that run only, leaving the other agent working and its task watch alive', async () => {
    const id = await channel('targeted-stop')
    const root = await post(seed.member, id, `${tag(builder)} ${tag(reviewer)} go`)
    const running = await waitFor(async () => {
      const rows = agentRows(await thread(root)).filter((r) => r.agentStatus === 'running')
      return rows.length === 2 ? rows : null
    })
    const builderRow = running.find((r) => r.authorAgentRef.projectId === builder)!
    const reviewerRow = running.find((r) => r.authorAgentRef.projectId === reviewer)!
    const [watch] = await tasks.createReplyTasks(reviewerRow.agentSessionId, root, [{ projectId: builder, name: 'Builder' }])

    const res = await app.request(`/api/conversation-messages/${builderRow.id}/stop`, {
      method: 'POST',
      headers: { 'x-user': seed.member },
    })
    expect(res.status).toBe(200)
    await waitFor(async () => (await db.conversationMessage.findUnique({ where: { id: builderRow.id } })).agentStatus === 'stopped')

    // Only the named reply's session was told to stop, and the other one is still working.
    expect(runtimeStops).toEqual([{ projectId: builder, sessionId: builderRow.agentSessionId, userId: seed.member }])
    expect((await db.conversationMessage.findUnique({ where: { id: reviewerRow.id } })).agentStatus).toBe('running')
    expect((await db.backgroundTask.findUnique({ where: { id: watch!.task_id } })).consumed).toBe(false)
    expect(inFlight).toBe(1)

    calls.find((c) => c.projectId === reviewer)!.release('Reviewed.')
    await waitFor(async () => (await db.conversationMessage.findUnique({ where: { id: reviewerRow.id } })).agentStatus === 'done', 5000)
    expect(calls).toHaveLength(2)
  })
})
