// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-205 QA gate — the turn-end hand-off, at its insert point.
 *
 * The card moves "clearing a turn → start the row waiting on it" into
 * `chat-turn-state.service`, so every ender inherits it. The two ways that can
 * go wrong are opposite and both silent:
 *
 *   - the hand-off does not fire, and a stop leaves a promoted row with no
 *     starter (the reported bug, one path over);
 *   - the hand-off fires when the caller said it would dispatch itself, and one
 *     Send now becomes two starters racing for one turn.
 *
 * `clearActiveTurn`'s default and `handOff: 'caller'` are the whole contract,
 * and no test drove it before this one: the acceptance spec stubs the stop
 * route and asserts the body it was sent, not what the real route then does.
 *
 * Real SQLite, real `chat-turn-state`, real queue dispatcher. The one seam is
 * the chat proxy a dispatched row posts to.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

type ChatPost = { projectId: string; body: Record<string, any> }
const chatPosts: ChatPost[] = []

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  projectChatRoutes: () => {
    const app = new Hono()
    app.post('/projects/:projectId/chat', async (c) => {
      chatPosts.push({ projectId: c.req.param('projectId')!, body: JSON.parse((await c.req.text()) || '{}') })
      return sseResponse([{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'ok' }, { type: 'finish' }])
    })
    return app
  },
}))
mock.module('../routes/workspace-chat', () => ({ workspaceChatRoutes: () => new Hono() }))

const { prisma } = await import('../lib/prisma')
const turnState = await import('../services/chat-turn-state.service')
const { dispatchQueuedRow } = await import('../services/chat-queue-dispatcher.service')

const db = prisma as any
let seed: SeededWorkspace

async function makeSession(overrides: Record<string, unknown> = {}): Promise<string> {
  const session = await db.chatSession.create({
    data: {
      inferredName: 'SHO-205 QA',
      contextType: 'project',
      contextId: seed.projectId,
      createdByUserId: seed.owner,
      ...overrides,
    },
  })
  return session.id
}

async function queuedRow(sessionId: string, content: string): Promise<string> {
  const created = await db.chatQueuedMessage.create({
    data: {
      sessionId,
      userId: seed.owner,
      position: 0,
      status: 'pending',
      content,
      parts: JSON.stringify([{ type: 'text', text: content }]),
      body: JSON.stringify({ text: content }),
    },
  })
  return created.id
}

async function savedUserMessages(sessionId: string): Promise<string[]> {
  const rows = await db.chatMessage.findMany({ where: { sessionId, role: 'user' }, select: { content: true } })
  return rows.map((row: any) => row.content)
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  chatPosts.length = 0
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-205 QA · clearing a turn hands the session on, unless the caller said it would', () => {
  /**
   * AC3 at the insert point. The stop routes clear a turn and take the default:
   * a row waiting behind that turn must start, with no drain worker and no
   * timer in the test at all.
   */
  test('a stop clears the turn and starts the row waiting on it', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-live', activeTurnStartedAt: new Date() })
    await queuedRow(sessionId, 'waited behind the stopped reply')

    await turnState.clearActiveTurn({ id: sessionId, contextId: seed.projectId })

    const session = await db.chatSession.findUnique({ where: { id: sessionId } })
    expect(session.activeTurnId).toBeNull()
    await waitFor(() => chatPosts.length === 1, 5_000)
    expect(chatPosts[0].body.text).toBe('waited behind the stopped reply')
    expect(await savedUserMessages(sessionId)).toEqual(['waited behind the stopped reply'])
  })

  /**
   * AC5 at the insert point. Send now's stop says `handOff: 'caller'` because
   * that route dispatches the clicked row itself and answers with the outcome.
   * If the stop drained too, one click would be two starters on one row.
   */
  test('a stop told the caller will dispatch clears the turn and starts nothing', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-live', activeTurnStartedAt: new Date() })
    const id = await queuedRow(sessionId, 'the clicked row')

    await turnState.clearActiveTurn({ id: sessionId, contextId: seed.projectId }, { handOff: 'caller' })

    const session = await db.chatSession.findUnique({ where: { id: sessionId } })
    expect(session.activeTurnId).toBeNull()
    // Give the fire-and-forget hand-off every chance to run before saying it did not.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chatPosts).toHaveLength(0)
    expect((await db.chatQueuedMessage.findUnique({ where: { id } }))?.status).toBe('pending')

    // …and the caller's own dispatch is what starts it, exactly once.
    const outcome = await dispatchQueuedRow(sessionId, id)
    expect(outcome.started).toBe(true)
    expect(chatPosts).toHaveLength(1)
    expect(chatPosts[0].body.text).toBe('the clicked row')
    expect(await savedUserMessages(sessionId)).toEqual(['the clicked row'])
  })

  /** A stop that matched nothing has no turn to follow: it must start nothing. */
  test('a stop that clears no turn does not drain the queue', async () => {
    const sessionId = await makeSession({ activeTurnId: 'turn-live', activeTurnStartedAt: new Date() })
    await queuedRow(sessionId, 'not mine to start')

    // Another project's stop naming this session: the scope does not match.
    await turnState.clearActiveTurn({ id: sessionId, contextId: 'p-somewhere-else' })

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chatPosts).toHaveLength(0)
    expect((await db.chatSession.findUnique({ where: { id: sessionId } })).activeTurnId).toBe('turn-live')
  })

  /**
   * `endTurnAndDrain` with no turn id: the stream that would have ended a turn
   * never marked one, so nothing is coming to clear it. The queue is drained
   * directly rather than waiting for a turn-end that cannot arrive.
   */
  test('an ender with no turn id still drains the queue', async () => {
    const sessionId = await makeSession()
    await queuedRow(sessionId, 'no turn was ever marked')

    await turnState.endTurnAndDrain(sessionId, undefined)

    await waitFor(() => chatPosts.length === 1, 5_000)
    expect(chatPosts[0].body.text).toBe('no turn was ever marked')
  })
})
