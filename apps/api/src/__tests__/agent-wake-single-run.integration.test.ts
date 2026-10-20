// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One live run per (agent, thread). A wake that arrives while the agent is
 * already working the thread is acknowledged in the thread and runs when that
 * reply ends — it never starts a second run on the same session, and nothing a
 * queued wake asked for is dropped.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let reviewer: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

interface Call {
  projectId: string | null
  sessionId: string
  prompt: string
  release: (text: string) => void
}

let calls: Call[] = []

function answer(text: string) {
  return sseResponse([
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'finish' },
  ])
}

/**
 * Every run blocks until the test releases it, so the next wake always finds a
 * live run to queue behind. This is the seam the dispatcher's `invoke` exists for.
 */
function gateRuns() {
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 60_000,
    stopRuntimeTurn: async () => {},
    invoke: (args) => new Promise<Response>((resolve, reject) => {
      calls.push({
        projectId: args.projectId,
        sessionId: args.sessionId,
        prompt: args.prompt,
        release: (text) => resolve(answer(text)),
      })
      args.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
}

async function post(user: string, conversationId: string, text: string, threadRootId?: string): Promise<string> {
  const res = await app.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'x-user': user, 'Content-Type': 'application/json' },
    body: JSON.stringify(threadRootId ? { text, threadRootId } : { text }),
  })
  return (await res.json() as any).message.id as string
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

/** Rows in a thread, oldest first, with `blocks` parsed out of its stored JSON. */
async function thread(threadRootId: string): Promise<any[]> {
  const rows = await db.conversationMessage.findMany({ where: { threadRootId }, orderBy: { seq: 'asc' } })
  return rows.map((row: any) => ({
    ...row,
    blocks: typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks,
  }))
}

const runningRows = (rows: any[]) => rows.filter((r) => r.authorType === 'agent' && r.agentStatus === 'running')

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  reviewer = (await db.project.create({ data: { name: 'Reviewer', workspaceId: seed.workspaceId } })).id
})

beforeEach(() => {
  calls = []
  dispatcher._resetDispatcherForTests()
  gateRuns()
})

afterAll(async () => {
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  await db.agentWake.deleteMany({})
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('a wake for an agent that is already running here', () => {
  test('queues behind the live run instead of starting a second one, and still runs', async () => {
    const id = await channel('single-run')
    const root = await post(seed.member, id, `${tag(builder)} build the thing`)
    await waitFor(() => calls.length === 1)

    // The agent is still working: this wake must not enter the runtime behind it.
    const second = await post(seed.member, id, `${tag(builder)} and also check the totals`, root)
    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toHaveLength(1)
    expect(runningRows(await thread(root))).toHaveLength(1)

    // The thread says so, in the thread, where a person can see it.
    const ack = (await thread(root)).find((m) => m.blocks?.wakeQueued)
    expect(ack?.authorType).toBe('system')
    expect(ack.text).toContain('still working on the previous message')
    expect(ack.blocks.wakeQueued.agentRef).toBe(`project:${builder}`)
    expect(ack.blocks.wakeQueued.triggerMessageId).toBe(second)
    expect(ack.blocks.wakeQueued.runningMessageId).toBe(runningRows(await thread(root))[0]?.id)

    // The queued wake still runs — once the live one ends, and with its own prompt.
    calls[0]!.release('Built it.')
    await waitFor(() => calls.length === 2, 5000)
    expect(calls[1]!.prompt).toContain('check the totals')
    calls[1]!.release('Totals are fine.')

    const settled = await waitFor(async () => {
      const rows = (await thread(root)).filter((r) => r.authorType === 'agent')
      return rows.length === 2 && rows.every((r) => r.agentStatus !== 'running') ? rows : null
    }, 5000)
    expect(settled.map((r) => r.text)).toEqual(['Built it.', 'Totals are fine.'])
    expect((await db.agentWake.findMany({ where: { conversationId: id } })).every((w: any) => w.status === 'done')).toBe(true)
  })

  test('two agents in one thread each get their own run', async () => {
    const id = await channel('two-agents')
    const root = await post(seed.member, id, `${tag(builder)} ${tag(reviewer)} look together`)
    await waitFor(() => calls.length === 2)
    expect(new Set(calls.map((c) => c.projectId))).toEqual(new Set([builder, reviewer]))

    for (const call of calls) call.release('On it.')
    await waitFor(async () => {
      const rows = (await thread(root)).filter((r) => r.authorType === 'agent')
      return rows.length === 2 && rows.every((r) => r.agentStatus === 'done')
    }, 5000)
  })

  test('a Stop ends the live run, and the wake queued behind it still runs', async () => {
    const id = await channel('stop-drain')
    const root = await post(seed.member, id, `${tag(builder)} first job`)
    await waitFor(() => calls.length === 1)
    await post(seed.member, id, `${tag(builder)} second job`, root)
    await waitFor(() => db.agentWake.findFirst({ where: { conversationId: id, status: 'pending' } }))

    const running = (await thread(root)).find((r) => r.authorType === 'agent' && r.agentStatus === 'running')
    const res = await app.request(`/api/conversation-messages/${running.id}/stop`, {
      method: 'POST',
      headers: { 'x-user': seed.member },
    })
    expect(res.status).toBe(200)

    // The queue is not stranded by the stop: it drains as the stopped reply settles.
    await waitFor(() => calls.length === 2, 5000)
    expect(calls[1]!.prompt).toContain('second job')
    calls[1]!.release('Second done.')
    const settled = await waitFor(async () => {
      const rows = (await thread(root)).filter((r) => r.authorType === 'agent')
      return rows.length === 2 && rows.every((r) => r.agentStatus !== 'running') ? rows : null
    }, 5000)
    expect(settled.map((r) => r.agentStatus)).toEqual(['stopped', 'done'])
  })

  test('a queued wake left behind by a restart is swept up and run', async () => {
    const id = await channel('swept-wake')
    // A message nobody ran (no tag): the queue row a crashed pod leaves behind.
    const root = await post(seed.member, id, 'pick this up later')
    await db.agentWake.create({
      data: {
        workspaceId: seed.workspaceId,
        conversationId: id,
        threadRootId: root,
        triggerMessageId: root,
        agentRef: `project:${builder}`,
        userId: seed.member,
        chain: null,
        status: 'pending',
      },
    })

    expect(await dispatcher.sweepPendingAgentWakes(-1_000)).toBe(1)
    await waitFor(() => calls.length === 1, 5000)
    expect(calls[0]!.prompt).toContain('pick this up later')
    calls[0]!.release('Picked it up.')
    await waitFor(() => db.agentWake.findFirst({ where: { conversationId: id, status: 'done' } }), 5000)
  })
})

describe('the session activity stamp', () => {
  test('a follow-up in the thread moves ChatSession.lastActiveAt', async () => {
    const id = await channel('activity-stamp')
    const root = await post(seed.member, id, `${tag(builder)} first look`)
    await waitFor(() => calls.length === 1)
    calls[0]!.release('Looked.')
    const first = await waitFor(async () => {
      const row = (await thread(root)).find((r) => r.authorType === 'agent' && r.agentStatus === 'done')
      return row ?? null
    }, 5000)

    const stale = new Date(Date.now() - 3_600_000)
    await db.chatSession.update({ where: { id: first.agentSessionId }, data: { lastActiveAt: stale } })

    // No tag: a follow-up in the thread wakes the agent that last replied there.
    await post(seed.member, id, 'what did you find?', root)
    await waitFor(() => calls.length === 2, 5000)
    expect(calls[1]!.sessionId).toBe(first.agentSessionId)
    const session = await db.chatSession.findUnique({ where: { id: first.agentSessionId } })
    expect(session.lastActiveAt.getTime()).toBeGreaterThan(stale.getTime())
    calls[1]!.release('Nothing yet.')
  })
})
