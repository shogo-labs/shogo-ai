// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-205 — Send now must start *that* message, or say why it didn't.
 *
 * SHO-198 answered the same report with a timer: the route fired `dispatchNext`
 * un-awaited and, if it didn't take the row, asked again after 2 s. That guesses
 * at the race instead of removing it, and anything still busy after 2 s stranded
 * the message exactly as before. The race is real and reproducible:
 *
 *   - the stop clears `activeTurnId`, and the stopped run's own settle then
 *     drains the thread's *wakes* (`drainWakes`), which start a rival turn on the
 *     same session;
 *   - `dispatchNext` sees a busy session and returns false;
 *   - `markTurnEnded` — how a channel run ends its turn — never drained the chat
 *     queue, so nothing came back for the row.
 *
 * This gate is written against the shape the fix has to have, with no timers in
 * it anywhere: the route dispatches the clicked row by id and answers with what
 * happened, a pending wake yields to a row waiting on the same session, and a
 * turn that ends always hands the session on.
 *
 * Every case here is red on origin/main:
 *   - `send-now` answered `{ ok: true, data: <still pending> }` and dispatched
 *     nothing unless a second, timer-driven attempt happened to land (AC1/AC4);
 *   - a `markTurnEnded` with a pending row started nothing at all (AC3);
 *   - a pending wake took the freed session before the promoted row (AC2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

/**
 * The one hop stubbed: the chat proxy the dispatcher posts a row to. Everything
 * else — the route, the queue claim, the turn state, the wake drain — is real.
 */
type ChatPost = { projectId: string; body: Record<string, any> }
const chatPosts: ChatPost[] = []
const stopCalls: Array<Record<string, any>> = []
/** What the stubbed runtime answers a dispatched row with. */
let chatStatus = 200

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  projectChatRoutes: () => {
    const app = new Hono()
    app.post('/projects/:projectId/chat', async (c) => {
      const body = JSON.parse((await c.req.text()) || '{}')
      chatPosts.push({ projectId: c.req.param('projectId')!, body })
      if (chatStatus !== 200) return c.json({ error: { code: 'proxy_error', message: 'runtime said no' } }, chatStatus as any)
      return sseResponse([{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'ok' }, { type: 'finish' }])
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
const dispatcher = await import('../services/conversation-agent-dispatcher')
const turnState = await import('../services/chat-turn-state.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono<{ Variables: { auth: any } }>()
app.use('*', async (c, next) => {
  c.set('auth', { userId: seed.owner, tunnelAuthenticated: true })
  await next()
})
app.route('/api/chat-queued-messages', chatQueuedMessageActionsRoutes())

function newSessionId(): string {
  return crypto.randomUUID()
}

async function makeSession(overrides: Record<string, unknown> = {}): Promise<string> {
  const session = await db.chatSession.create({
    data: {
      inferredName: 'SHO-205',
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

/** The user messages this test's dispatches saved, by content. */
async function savedUserMessages(sessionId: string): Promise<string[]> {
  const rows = await db.chatMessage.findMany({ where: { sessionId, role: 'user' }, select: { content: true } })
  return rows.map((row: any) => row.content)
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  // A run the drain starts has to answer something: the dispatcher's one seam.
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 5_000,
    stopRuntimeTurn: async () => {},
    invoke: async () =>
      sseResponse([{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'ack' }, { type: 'finish' }]),
  })
})

beforeEach(() => {
  chatPosts.length = 0
  stopCalls.length = 0
  chatStatus = 200
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-205 · Send now starts the clicked row and says what happened', () => {
  /**
   * AC1 + AC4. The reply is running, two rows wait behind it, and the person
   * clicks the *second* one. One round-trip later that row is the message that
   * started — not "whatever the queue picks if the session reads idle".
   */
  test('the clicked row is the one that starts, and the answer says so', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-live', activeTurnStartedAt: new Date() })
    const first = await queuedRow(sessionId, 'first in line', 0)
    const clicked = await queuedRow(sessionId, 'clicked send now', 1)

    const res = await sendNow(clicked)

    expect(res.status).toBe(200)
    expect(res.json.status).toBe('started')
    expect(res.json.ok).toBe(true)
    // The stop ran, and it handed the queue back to this route instead of
    // starting a second turn of its own.
    expect(stopCalls).toHaveLength(1)
    expect(stopCalls[0].handOff).toBe('caller')
    // Exactly one turn started, and it was the clicked row's.
    expect(chatPosts).toHaveLength(1)
    expect(chatPosts[0].body.text).toBe('clicked send now')
    expect(await savedUserMessages(sessionId)).toEqual(['clicked send now'])
    // Its row is gone; the other one is still queued and untouched.
    expect(await db.chatQueuedMessage.findUnique({ where: { id: clicked } })).toBeNull()
    const stillQueued = await db.chatQueuedMessage.findUnique({ where: { id: first } })
    expect(stillQueued?.status).toBe('pending')
  })

  /**
   * AC4. A row that cannot start must not be swallowed: the reason is in the
   * response *and* on the row, so the dock can put the message back with it.
   */
  test('a row that cannot start reports the reason and stays sendable', async () => {
    const sessionId = await makeSession()
    const id = await queuedRow(sessionId, 'never starts')

    chatStatus = 503
    const res = await sendNow(id)

    expect(res.status).toBe(502)
    expect(res.json.ok).toBe(false)
    expect(res.json.status).toBe('failed')
    expect(String(res.json.error.message)).toContain('runtime said no')

    const row = await db.chatQueuedMessage.findUnique({ where: { id } })
    expect(row?.status).toBe('failed')
    expect(String(row?.error)).toContain('runtime said no')
  })

  /** AC5. Two clicks on one row are one message and one turn. */
  test('clicking twice starts the message once', async () => {
    const sessionId = await makeSession()
    const id = await queuedRow(sessionId, 'only once')

    const [a, b] = await Promise.all([sendNow(id), sendNow(id)])

    expect(chatPosts).toHaveLength(1)
    expect(await savedUserMessages(sessionId)).toEqual(['only once'])
    // Neither click is told a lie: the row either started here or was already
    // claimed by the other click, and both are "started".
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.json.status).toBe('started')
    expect(b.json.status).toBe('started')
  })
})

describe('SHO-205 · a turn that ends always hands the session on', () => {
  /**
   * AC3. A channel run ends its turn with `markTurnEnded`. A row waiting on
   * that session used to sit there until the 15 s drain worker — or forever,
   * when the worker had already had its turn. Nothing here waits on a timer:
   * this test runs no worker at all.
   */
  test('markTurnEnded starts the row waiting behind the turn', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-channel', activeTurnStartedAt: new Date() })
    await queuedRow(sessionId, 'queued behind the channel run')

    await turnState.markTurnEnded(sessionId, 'turn-channel')

    await waitFor(() => chatPosts.length === 1, 5_000)
    expect(chatPosts[0].body.text).toBe('queued behind the channel run')
    expect(await savedUserMessages(sessionId)).toEqual(['queued behind the channel run'])
  })

  /** A stale or duplicate completion cleared nothing, so it must start nothing. */
  test('a turn that was already cleared does not start a second one', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-current', activeTurnStartedAt: new Date() })
    await queuedRow(sessionId, 'waits for its own turn')

    // Not the active turn: a delayed completion from an older stream.
    await turnState.markTurnEnded(sessionId, 'turn-old')

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chatPosts).toHaveLength(0)
  })
})

describe('SHO-205 · one starter per session, in one order', () => {
  /**
   * AC2, the reported shape. A thread-bound session has a pending wake, the
   * person presses Send now, and the stopped run's settle drains the wake. The
   * wake used to win — it marked its own turn and the promoted row was left
   * with no starter. It has to yield, and run after the person's message.
   */
  test('a pending wake yields to the queued message, then runs after it', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-thread', activeTurnStartedAt: new Date() })
    const id = await queuedRow(sessionId, 'the person went first')

    const conversation = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'channel', name: 'eng', slug: `eng-${crypto.randomUUID().slice(0, 8)}` },
    })
    const trigger = await db.conversationMessage.create({
      data: {
        workspaceId: seed.workspaceId,
        conversationId: conversation.id,
        authorType: 'user',
        authorUserId: seed.owner,
        text: '@Shogo Dev 1 look at this',
        seq: 0,
      },
    })
    const wake = await db.agentWake.create({
      data: {
        workspaceId: seed.workspaceId,
        conversationId: conversation.id,
        threadRootId: null,
        triggerMessageId: trigger.id,
        agentRef: `project:${seed.projectId}`,
        userId: seed.owner,
        reason: 'wake',
        status: 'pending',
        chatSessionId: sessionId,
      },
    })

    // The clicked row starts; the wake behind it is untouched, not claimed.
    const res = await sendNow(id)
    expect(res.json.status).toBe('started')
    await waitFor(() => chatPosts.length === 1, 5_000)
    expect(chatPosts[0].body.text).toBe('the person went first')

    const afterClick = await db.agentWake.findUnique({ where: { id: wake.id } })
    expect(afterClick.status).toBe('pending')
    expect(afterClick.attempts).toBe(0)

    // The person's message is the only turn that started. The wake was not
    // claimed, not consumed and not failed — it is still next in line, and the
    // sweep is the starter that picks it up (the same one production relies on
    // when a wake yields).
    await dispatcher.sweepPendingAgentWakes(0)
    const ran = await waitFor(async () => {
      const row = await db.agentWake.findUnique({ where: { id: wake.id } })
      return ['done', 'failed', 'superseded'].includes(row.status) ? row : null
    }, 20_000)
    expect(ran.status).toBe('done')
    expect(await savedUserMessages(sessionId)).toEqual(['the person went first'])
  }, 30_000)
})
