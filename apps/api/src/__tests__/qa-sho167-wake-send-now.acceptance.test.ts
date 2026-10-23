// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-167 — a queued team-chat wake a person can act on.
 *
 * The gate, from the outside: one note (edited, never re-posted) carries the
 * wake's id and follows its state; Send now stops the reply in front of it and
 * puts it first, whichever wake it is; the session's dock lists the same row
 * and stops listing it once it drains; ✕ means it never runs; and the rows that
 * are not a person's message — a workspace-pause hold, a retry hint — keep the
 * surface they have today.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { agentWakeRoutes } = await import('../routes/agent-wakes')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let reviewer: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', agentWakeRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

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

/** Every run blocks until the test releases it, so a second tag always lands behind a live reply. */
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
const wakeNotes = (rows: any[]) => rows.filter((r) => r.blocks?.wakeQueued)

const pendingWake = async (conversationId: string) => {
  const rows = await db.agentWake.findMany({ where: { conversationId, status: 'pending' }, orderBy: { createdAt: 'asc' } })
  return rows
}

const dock = (sessionId: string, user: string = seed.member) =>
  app.request(`/api/agent-wakes?sessionId=${encodeURIComponent(sessionId)}`, { headers: { 'x-user': user } })

const sendNow = (wakeId: string, user: string = seed.member) =>
  app.request(`/api/agent-wakes/${wakeId}/send-now`, { method: 'POST', headers: { 'x-user': user } })

const removeWake = (wakeId: string, user: string = seed.member) =>
  app.request(`/api/agent-wakes/${wakeId}`, { method: 'DELETE', headers: { 'x-user': user } })

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

describe('SHO-167 a queued wake in the thread', () => {
  test('AC1/AC4: one note carries the wake and its session, and follows it to done without being re-posted', async () => {
    const id = await channel('qa167-note')
    const root = await post(seed.member, id, `${tag(builder)} first job`)
    await waitFor(() => calls.length === 1)
    const running = runningRows(await thread(root))[0]
    expect(running.agentSessionId).toBeTruthy()

    await post(seed.member, id, `${tag(builder)} second job`, root)
    const [wake] = await waitFor(async () => {
      const rows = await pendingWake(id)
      return rows.length === 1 ? rows : null
    })

    const notes = wakeNotes(await thread(root))
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(note.authorType).toBe('system')
    expect(note.blocks.wakeQueued).toMatchObject({
      wakeId: wake.id,
      status: 'pending',
      agentName: 'Builder',
    })
    // The old sentence is gone from the app's text: the row says what it is and offers a button.
    expect(note.text).not.toContain('still working on the previous message')
    expect(note.text).toContain('Queued for Builder')
    // The dock finds the wake by the session the live reply holds.
    expect(wake.chatSessionId).toBe(running.agentSessionId)
    expect(wake.noteMessageId).toBe(note.id)

    calls[0]!.release('First done.')
    await waitFor(() => calls.length === 2, 5000)
    const running1 = wakeNotes(await thread(root))[0]!
    expect(running1.id).toBe(note.id)
    expect(running1.blocks.wakeQueued.status).toBe('running')

    calls[1]!.release('Second done.')
    const settled = await waitFor(async () => {
      const row = wakeNotes(await thread(root))
      return row.length === 1 && row[0]!.blocks.wakeQueued.status === 'done' ? row[0] : null
    }, 5000)
    // Edited in place: one row in the thread for one queued message.
    expect(settled.id).toBe(note.id)
  }, 20_000)

  test('AC2: Send now stops the reply in front of it and runs that message first, even when it is the older wake', async () => {
    const id = await channel('qa167-send-now')
    const root = await post(seed.member, id, `${tag(builder)} first job`)
    await waitFor(() => calls.length === 1)
    await post(seed.member, id, `${tag(builder)} older queued job`, root)
    await post(seed.member, id, `${tag(builder)} newer queued job`, root)
    const queued = await waitFor(async () => {
      const rows = await pendingWake(id)
      return rows.length === 2 ? rows : null
    })
    const older = queued[0]!
    const newer = queued[1]!
    expect(older.triggerMessageId).not.toBe(newer.triggerMessageId)

    expect((await sendNow(older.id)).status).toBe(200)

    // The reply in front of it stops the way the Stop button stops it...
    await waitFor(async () => {
      const rows = await thread(root)
      return rows.some((r) => r.authorType === 'agent' && r.agentStatus === 'stopped')
    }, 5000)
    // ...and the older message — the one that was sent now — is the next run.
    await waitFor(() => calls.length === 2, 5000)
    expect(calls[1]!.prompt).toContain('older queued job')
    expect(calls[1]!.sessionId).toBe(calls[0]!.sessionId)

    const sentNote = wakeNotes(await thread(root)).find((m) => m.blocks.wakeQueued.wakeId === older.id)
    expect(sentNote.blocks.wakeQueued.sentNowBy.id).toBe(seed.member)

    calls[1]!.release('Older done.')
    await waitFor(() => calls.length === 3, 5000)
    expect(calls[2]!.prompt).toContain('newer queued job')
    calls[2]!.release('Newer done.')
    await waitFor(async () => (await pendingWake(id)).length === 0, 5000)
  }, 25_000)

  test('AC5: ✕ takes it off the queue, the note says Removed, and it never runs', async () => {
    const id = await channel('qa167-remove')
    const root = await post(seed.member, id, `${tag(builder)} first job`)
    await waitFor(() => calls.length === 1)
    await post(seed.member, id, `${tag(builder)} drop this one`, root)
    const [wake] = await waitFor(async () => {
      const rows = await pendingWake(id)
      return rows.length === 1 ? rows : null
    })

    expect((await removeWake(wake.id)).status).toBe(200)
    const note = wakeNotes(await thread(root))[0]!
    expect(note.blocks.wakeQueued.status).toBe('removed')

    // The live reply ends normally: the removed wake is not picked up after it.
    calls[0]!.release('First done.')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(calls).toHaveLength(1)
    expect(await pendingWake(id)).toHaveLength(0)
  }, 20_000)
})

describe('SHO-167 the session\'s queue dock', () => {
  test('AC3/AC4/AC6: lists the waiting wake with its channel and author, refuses a viewer, and drops it once it drains', async () => {
    const id = await channel('qa167-dock')
    const root = await post(seed.member, id, `${tag(builder)} list me`)
    await waitFor(() => calls.length === 1)
    const running = runningRows(await thread(root))[0]

    await post(seed.member, id, `${tag(builder)} look at the totals`, root)
    const [wake] = await waitFor(async () => {
      const rows = await pendingWake(id)
      return rows.length === 1 ? rows : null
    })

    const listed = await dock(running.agentSessionId)
    expect(listed.status).toBe(200)
    const body = await listed.json() as any
    expect(body.wakes).toHaveLength(1)
    expect(body.wakes[0]).toMatchObject({
      id: wake.id,
      status: 'pending',
      conversationId: id,
      channelName: 'qa167-dock',
    })
    expect(body.wakes[0].author.name).toBe('member')
    expect(body.wakes[0].text).toBe('@Builder look at the totals')

    // A viewer reads the channel but cannot start or drop its queue.
    expect((await sendNow(wake.id, seed.viewer)).status).toBe(403)
    // Someone outside the workspace is not told the session has anything waiting.
    expect((await (await dock(running.agentSessionId, seed.outsider)).json() as any).wakes).toEqual([])

    // The wake drains on its own when the reply ends: the dock stops listing it, no reload.
    calls[0]!.release('First done.')
    await waitFor(() => calls.length === 2, 5000)
    const drained = await dock(running.agentSessionId)
    expect((await drained.json() as any).wakes).toEqual([])
    calls[1]!.release('Totals done.')
    // A wake that already ran cannot be sent again.
    const again = await sendNow(wake.id)
    expect(again.status).toBe(409)
    expect((await again.json() as any).error.code).toBe('not_pending')
  }, 25_000)

  test('AC7: a pause hold and a retry hint are not rows in the dock, have no note, and cannot be sent now', async () => {
    const id = await channel('qa167-hints')
    const root = await post(seed.member, id, 'pick this up later')
    const second = await post(seed.member, id, 'and this one after the restart', root)
    // The rows the pause and the retry hint actually enqueue: no note, no session.
    const held = await dispatcher.enqueueAgentWake({
      conversationId: id,
      threadRootId: root,
      triggerMessageId: root,
      agentRef: `project:${builder}`,
      userId: seed.member,
      reason: 'paused',
    })
    const hint = await dispatcher.enqueueAgentWake({
      conversationId: id,
      threadRootId: root,
      triggerMessageId: second,
      agentRef: `project:${builder}`,
      userId: seed.member,
      reason: dispatcher.RUN_DIED_RETRY_REASON,
    })
    expect(held).toBeTruthy()
    expect(hint).toBeTruthy()

    const rows = await db.agentWake.findMany({ where: { id: { in: [held, hint] } } })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.noteMessageId).toBeNull()
      expect(row.chatSessionId).toBeNull()
    }
    // Neither posted a note in the thread.
    expect(wakeNotes(await thread(root))).toHaveLength(0)

    // They are not a person's queued message: the dock does not show them, and
    // Send now refuses them rather than starting something nobody typed. The
    // dock reads by session id alone, so an id with nothing behind it is enough.
    const session = { id: crypto.randomUUID() }
    expect((await (await dock(session.id)).json() as any).wakes).toEqual([])
    const refused = await sendNow(held)
    expect(refused.status).toBe(409)
    expect((await refused.json() as any).error.code).toBe('not_pending')
    expect(await pendingWake(id)).toHaveLength(2)
  }, 20_000)
})
