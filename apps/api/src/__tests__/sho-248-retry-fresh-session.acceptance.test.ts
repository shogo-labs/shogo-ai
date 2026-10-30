// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A retry after a run that died must not resume the session that died (SHO-248).
 *
 * SHO-178 was re-handed three times and every run failed the same way, because
 * each retry appended to one session that had been open for ten hours: the turn
 * re-sends that session's transcript, so the prompt that stalled once stalled
 * again. The card's own re-hand path now opens a new session, seeded only with
 * the card's summary and the thread's recent messages.
 *
 * The marker below stands for the accumulated transcript. With the fix the
 * retry's turn carries neither it nor the old session; with the dispatcher
 * change reverted both assertions fail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

// Read at module load by the board service: a real backoff is a minute, which
// no test waits for.
process.env.SHOGO_CARD_RETRY_BACKOFF_MS = '400'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { workBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/work-boards.service')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let dev: string
let channelId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

/** The oldest line of the bloated transcript. Nothing a retry sends may carry it. */
const MARKER = 'SHO248-OLDEST-TRANSCRIPT-LINE-7f3c'
/** A fixed ceiling for one retry's prompt: the thread's tail plus the hand-off. */
const PROMPT_CHAR_BOUND = 20_000

interface Call {
  projectId: string | null
  sessionId: string
  prompt: string
  seedChars: number
  /** Everything the turn sends: the prompt plus the history seed the runtime would rebuild from. */
  outgoing: string
  release: (text: string) => void
}
let calls: Call[] = []

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  dev = (await db.project.create({ data: { name: 'Dev', workspaceId: seed.workspaceId } })).id
  const { channel } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name: 'sho248',
    agents: [{ projectId: dev, agentTrigger: 'mention' }],
    userEmails: [],
  })
  channelId = channel.id as string
})

beforeEach(() => {
  calls = []
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 60_000,
    stopRuntimeTurn: async () => {},
    invoke: (args) => new Promise<Response>((resolve) => {
      const seedText = args.historySeed
        ? JSON.stringify({ summary: args.historySeed.summary, messages: args.historySeed.messages })
        : ''
      calls.push({
        projectId: args.projectId,
        sessionId: args.sessionId,
        prompt: args.prompt,
        seedChars: seedText.length,
        outgoing: `${args.prompt}\n${seedText}`,
        // A run that ends without moving the card is what a stranded ending is.
        release: (text) => resolve(sseResponse([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'finish' },
        ])),
      })
    }),
  })
})

afterAll(async () => {
  dispatcher._resetDispatcherForTests()
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  await db.agentWake.deleteMany({})
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'x-user': seed.member, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function board(name: string) {
  const created = await call('POST', `/workspaces/${seed.workspaceId}/boards`, {
    conversationId: channelId,
    name,
    columns: [
      { name: 'Backlog', category: 'backlog' },
      { name: 'In Development', category: 'active' },
      { name: 'Needs attention', category: 'waiting' },
      { name: 'Done', category: 'done' },
    ],
  })
  expect(created.status).toBe(201)
  return created.json.board
}

/**
 * A card the dev owns. The assignment is written straight to the row — a card
 * created with `assigneeAgentRef` wakes the agent, and that run would be the
 * first thing this file measured.
 */
async function cardOn(b: any, title: string, historySummary?: string) {
  const created = await call('POST', `/boards/${b.id}/items`, { title, column: 'Backlog' })
  const card = created.json.item
  await db.workItem.update({
    where: { id: card.id },
    data: { assigneeAgentRef: `project:${dev}`, ...(historySummary ? { historySummary } : {}) },
  })
  expect(calls).toHaveLength(0)
  return card
}

/** The session that ran for ten hours: a real transcript, and a marker in its oldest line. */
async function bloatedSession(label: string): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: label, contextType: 'project', contextId: dev },
  })
  const base = Date.now() - 10 * 3_600_000
  for (let i = 0; i < 220; i++) {
    const text = i === 0 ? `${MARKER}: the first thing this agent was ever asked` : `Transcript line ${i} of a session that stayed open for ten hours.`
    await db.chatMessage.create({
      data: {
        sessionId: session.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: text,
        parts: JSON.stringify([{ type: 'text', text }]),
        createdAt: new Date(base + i * 1_000),
      },
    })
  }
  return session.id
}

/** A reply row that settled with an error, in the session that died — as a quiet timeout leaves it. */
async function failedReply(card: any, sessionId: string): Promise<any> {
  return db.conversationMessage.create({
    data: {
      conversationId: card.conversationId,
      workspaceId: seed.workspaceId,
      seq: 9_000 + Math.floor(Math.random() * 100_000),
      threadRootId: card.threadRootMessageId,
      authorType: 'agent',
      authorAgentRef: { projectId: dev, name: 'Dev' },
      agentSessionId: sessionId,
      agentStatus: 'error',
      text: 'The agent went quiet for 10m, so I stopped waiting on it.',
    },
  })
}

/** A reply row that settled cleanly in `sessionId`. */
async function cleanReply(card: any, sessionId: string): Promise<any> {
  return db.conversationMessage.create({
    data: {
      conversationId: card.conversationId,
      workspaceId: seed.workspaceId,
      seq: 9_000 + Math.floor(Math.random() * 100_000),
      threadRootId: card.threadRootMessageId,
      authorType: 'agent',
      authorAgentRef: { projectId: dev, name: 'Dev' },
      agentSessionId: sessionId,
      agentStatus: 'done',
      text: 'Moved it to Done.',
    },
  })
}

const retryEvent = async (card: any): Promise<any> => {
  const rows = await db.workItemEvent.findMany({ where: { workItemId: card.id, type: 'agent_retry' } })
  expect(rows).toHaveLength(1)
  const data = rows[0].eventData
  return typeof data === 'string' ? JSON.parse(data) : data
}

describe('a card whose run died', () => {
  test('its retry runs in a new session, seeded without the old transcript', async () => {
    const b = await board('retry')
    const card = await cardOn(b, 'Recover this card', 'The build is done; only the docs check is left.')
    const dead = await bloatedSession('Dev on SHO-999')
    const failed = await failedReply(card, dead)

    await service.noteCardRunEnded({
      threadRootId: card.threadRootMessageId,
      projectId: dev,
      messageId: failed.id,
      agentStatus: 'error',
      startedAt: new Date(failed.createdAt),
    })

    // The retry fires after its backoff and starts one run.
    const retry = await waitFor(() => (calls.length === 1 ? calls[0]! : null), 8_000)
    expect(retry.projectId).toBe(dev)

    // Neither the prompt nor the seed the runtime rebuilds from carries the old transcript.
    expect(retry.outgoing).not.toContain(MARKER)
    expect(retry.prompt).not.toContain(MARKER)
    expect(retry.seedChars).toBe(0)
    expect(retry.prompt.length).toBeLessThan(PROMPT_CHAR_BOUND)

    // A new session, not the one that stalled.
    expect(retry.sessionId).not.toBe(dead)
    expect(await db.chatSession.findUnique({ where: { id: retry.sessionId } })).toBeTruthy()

    // It is seeded with the hand-off and the card's own state, not the transcript.
    expect(retry.prompt).toContain(card.key)
    expect(retry.prompt).toContain('**Re-handed**')
    expect(retry.prompt).toContain('only the docs check is left')

    // The card records which session the retry ran in, and that it was new.
    const event = await retryEvent(card)
    expect(event.previousSessionId).toBe(dead)
    expect(event.sessionId).toBe(retry.sessionId)
    expect(event.fresh).toBe(true)

    retry.release('Back on it.')
  }, 30_000)

  test('an automatic re-hand after the death also starts a new session', async () => {
    const b = await board('rehand')
    const card = await cardOn(b, 'Handed back by a person')
    const dead = await bloatedSession('Dev on SHO-998')
    await failedReply(card, dead)

    const woken = await service.wakeAgent(card.id, `project:${dev}`, { agentRef: null }, 'assigned')
    expect(woken.woken).toBe(true)

    const run = await waitFor(() => (calls.length === 1 ? calls[0]! : null), 8_000)
    expect(run.sessionId).not.toBe(dead)
    expect(run.outgoing).not.toContain(MARKER)
    expect(run.prompt.length).toBeLessThan(PROMPT_CHAR_BOUND)
    run.release('Picking it up.')
  }, 30_000)

  test('a person replying after a successful run still resumes its session', async () => {
    const b = await board('healthy')
    const card = await cardOn(b, 'A card that is fine')
    const live = await bloatedSession('Dev on SHO-997')
    await cleanReply(card, live)

    // A person's own tag in the card's thread: the healthy follow-up.
    const res = await app.request(`/api/conversations/${card.conversationId}/messages`, {
      method: 'POST',
      headers: { 'x-user': seed.member, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `<@a:p:${dev}> one more thing`, threadRootId: card.threadRootMessageId }),
    })
    expect(res.status).toBe(201)

    const run = await waitFor(() => (calls.length === 1 ? calls[0]! : null), 8_000)
    expect(run.sessionId).toBe(live)
    run.release('On it.')
  }, 30_000)
})
