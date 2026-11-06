// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-341 — with several messages in the queue, Send now on one sent more than
 * one. `activeTurnId` is the only "this session is busy" marker, and it is
 * written by `markTurnStarted` *after* the runtime answers the internal `/chat`
 * POST. Between a claim (`status: 'dispatching'`) and that write the session has
 * a turn in flight and no marker for it, so every other starter — the 15 s drain
 * tick, an enqueue hook, a late turn-end, a hand-off — read it as idle and
 * claimed the *next* row. Send now widens that window to seconds, because the
 * stop it does first clears `activeTurnId` outright and the runtime's live-turn
 * gate holds the POST while the stopped turn unwinds.
 *
 * Every case here is red on origin/main:
 *   - `dispatchNext` during the claim takes the next row (AC1/AC2);
 *   - a second Send now inside that window is accepted instead of refused (AC2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import {
  seedWorkspace,
  setupChannelsTestDb,
  sseResponse,
  waitFor,
  type SeededWorkspace,
} from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

/** The one hop stubbed: the chat proxy. Everything else is the real route. */
type ChatPost = { projectId: string; body: Record<string, any> }
const chatPosts: ChatPost[] = []
const stopCalls: Array<Record<string, any>> = []

/**
 * Hold the proxy's answer open, so the test sits inside the exact window the
 * bug lived in: the row is claimed, its user message is persisted, the POST is
 * in flight, and `activeTurnId` has not been written yet.
 */
const gate = {
  holding: false,
  entered: 0,
  releases: [] as Array<() => void>,
  async wait() {
    this.entered++
    if (!this.holding) return
    await new Promise<void>((resolve) => this.releases.push(resolve))
  },
  open() {
    this.holding = false
    for (const release of this.releases.splice(0)) release()
  },
  reset() {
    this.open()
    this.entered = 0
  },
}

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  projectChatRoutes: () => {
    const app = new Hono()
    app.post('/projects/:projectId/chat', async (c) => {
      const body = JSON.parse((await c.req.text()) || '{}')
      chatPosts.push({ projectId: c.req.param('projectId')!, body })
      await gate.wait()
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'ok' },
        { type: 'finish' },
      ])
    })
    app.post('/projects/:projectId/chat/stop', async (c) => {
      stopCalls.push(JSON.parse((await c.req.text()) || '{}'))
      return c.json({ success: true })
    })
    return app
  },
}))
mock.module('../routes/workspace-chat', () => ({ workspaceChatRoutes: () => new Hono() }))

const { prisma } = await import('../lib/prisma')
const { chatQueuedMessageActionsRoutes } = await import('../routes/chat-queued-message-actions')
const { dispatchNext, resetStuckDispatching } = await import('../services/chat-queue-dispatcher.service')
const { configureConversationAgentDispatcher } = await import('../services/conversation-agent-dispatcher')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono<{ Variables: { auth: any } }>()
app.use('*', async (c, next) => {
  c.set('auth', { userId: seed.owner, tunnelAuthenticated: true })
  await next()
})
app.route('/api/chat-queued-messages', chatQueuedMessageActionsRoutes())

async function makeSession(overrides: Record<string, unknown> = {}): Promise<string> {
  const session = await db.chatSession.create({
    data: {
      inferredName: 'SHO-341',
      contextType: 'project',
      contextId: seed.projectId,
      createdByUserId: seed.owner,
      ...overrides,
    },
  })
  return session.id
}

async function queuedRow(sessionId: string, content: string, position = 0): Promise<string> {
  const created = await db.chatQueuedMessage.create({
    data: {
      sessionId,
      userId: seed.owner,
      position,
      status: 'pending',
      content,
      parts: JSON.stringify([{ type: 'text', text: content }]),
      body: JSON.stringify({ text: content }),
    },
  })
  return created.id
}

async function sendNow(id: string) {
  const res = await app.request(`/api/chat-queued-messages/${id}/send-now`, { method: 'POST' })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function startedPrompts(): string[] {
  return chatPosts.map((post) => String(post.body.text ?? ''))
}

async function queued(sessionId: string): Promise<Array<[string, string]>> {
  const rows = await db.chatQueuedMessage.findMany({
    where: { sessionId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { content: true, status: true },
  })
  return rows.map((row: any) => [row.content, row.status] as [string, string])
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 5_000,
    stopRuntimeTurn: async () => {},
    invoke: async () =>
      sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'ack' },
        { type: 'finish' },
      ]),
  })
})

beforeEach(() => {
  chatPosts.length = 0
  stopCalls.length = 0
  gate.reset()
})

afterAll(async () => {
  gate.open()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-341 · Send now with a full queue starts one turn', () => {
  /**
   * AC1 + AC2. Three messages wait behind a streaming turn and the person
   * clicks Send now on #2. Exactly one turn starts — #2 — and no drain tick can
   * take a second row while that claim is still on its way to
   * `markTurnStarted`. #1 and #3 then run one at a time, in order.
   */
  test('Send now on #2 starts exactly one turn, then the rest run in order', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-live', activeTurnStartedAt: new Date() })
    await queuedRow(sessionId, 'first in line', 0)
    const clicked = await queuedRow(sessionId, 'second in line', 1)
    await queuedRow(sessionId, 'third in line', 2)

    gate.holding = true
    const click = sendNow(clicked)
    await waitFor(() => chatPosts.length === 1, 5_000)
    expect(startedPrompts()).toEqual(['second in line'])

    // Two drain ticks while the claim is in flight: nothing may start.
    expect(await dispatchNext(sessionId)).toBe(false)
    expect(await dispatchNext(sessionId)).toBe(false)
    expect(startedPrompts()).toEqual(['second in line'])

    gate.open()
    const res = await click
    expect(res.status).toBe(200)
    expect(res.json.status).toBe('started')
    // One stop, and it handed the queue back to this route.
    expect(stopCalls).toHaveLength(1)
    expect(stopCalls[0].handOff).toBe('caller')

    // The clicked row is gone; the other two are still queued, untouched.
    expect(await queued(sessionId)).toEqual([
      ['first in line', 'pending'],
      ['third in line', 'pending'],
    ])

    // The session frees up: one row at a time, in queue order.
    expect(await dispatchNext(sessionId)).toBe(true)
    expect(startedPrompts()).toEqual(['second in line', 'first in line'])
    expect(await dispatchNext(sessionId)).toBe(true)
    expect(startedPrompts()).toEqual(['second in line', 'first in line', 'third in line'])
    expect(await queued(sessionId)).toEqual([])
  })

  /**
   * AC2, the other starter. A second click inside the window must be refused
   * *before* it promotes or stops anything, so it cannot put a second turn
   * beside the first. The row keeps its place and runs next.
   */
  test('a second Send now while a claim is live is refused, not started', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-live', activeTurnStartedAt: new Date() })
    const firstClick = await queuedRow(sessionId, 'clicked first', 0)
    const secondClick = await queuedRow(sessionId, 'clicked second', 1)

    gate.holding = true
    const first = sendNow(firstClick)
    await waitFor(() => chatPosts.length === 1, 5_000)

    const refused = await sendNow(secondClick)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('busy')
    expect(startedPrompts()).toEqual(['clicked first'])
    // Nothing was stopped for the refused click, and its row is untouched.
    expect(stopCalls).toHaveLength(1)
    expect(await queued(sessionId)).toEqual([
      ['clicked first', 'dispatching'],
      ['clicked second', 'pending'],
    ])

    gate.open()
    expect((await first).status).toBe(200)
  })

  /**
   * AC3. A claim that died (the API process went away, the pod was killed)
   * must not wedge the queue: past the same 2-minute cutoff
   * `resetStuckDispatching` recovers at, the row no longer counts as busy.
   */
  test('a claim stuck past the cutoff is recovered instead of blocking the queue', async () => {
    const sessionId = await makeSession()
    const stuck = await queuedRow(sessionId, 'stuck claim', 0)
    await db.chatQueuedMessage.update({
      where: { id: stuck },
      data: { status: 'dispatching', updatedAt: new Date(Date.now() - 5 * 60 * 1000) },
    })

    expect(await resetStuckDispatching()).toBeGreaterThanOrEqual(1)
    const recovered = await db.chatQueuedMessage.findUnique({ where: { id: stuck } })
    expect(recovered?.status).toBe('pending')

    // And the session it was holding is startable again.
    expect(await dispatchNext(sessionId)).toBe(true)
    expect(startedPrompts()).toEqual(['stuck claim'])
    expect(await queued(sessionId)).toEqual([])
  })
})
