// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-93.
 *
 * The dev's `stranded-card-run.integration.test.ts` calls `noteCardRunEnded` by
 * hand. SHO-84's failure was on the *production* path — a reply row that settles
 * `error` reaches the handler through the work-board post hook — so these tests
 * enter the same way production does, and use the Shogo Dev board's real column
 * set (its only `waiting` column is `Needs Info`, not `Needs attention`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SHOGO_CARD_RETRY_BACKOFF_MS = '400'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { workBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/work-boards.service')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const pipeline = await import('../services/conversation-pipeline')
const conversation = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace
let dev: string
let qa: string
let channelId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'x-user': seed.member, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

interface Run { projectId: string | null; prompt: string; release: (text: string) => void; fail: () => void }
let calls: Run[] = []
const runsOf = (key: string) => calls.filter((c) => c.prompt.includes(`work_item_get("${key}")`))

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  dev = (await db.project.create({ data: { name: 'Dev', workspaceId: seed.workspaceId } })).id
  qa = (await db.project.create({ data: { name: 'QA', workspaceId: seed.workspaceId } })).id
  const created = await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'dev-board' })
  channelId = created.json.conversation.id
  service.registerWorkBoardHooks()
})

beforeEach(async () => {
  calls = []
  dispatcher._resetDispatcherForTests()
  await db.agentWake.deleteMany({})
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 60_000,
    stopRuntimeTurn: async () => {},
    invoke: (args) => new Promise<Response>((resolve) => {
      calls.push({
        projectId: args.projectId,
        prompt: args.prompt,
        fail: () => resolve(new Response('boom', { status: 500 })),
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

/** The Shogo Dev board's real shape: one waiting column, called `Needs Info`. */
async function devBoard(name: string) {
  const created = await call('POST', `/workspaces/${seed.workspaceId}/boards`, {
    conversationId: channelId,
    name,
    columns: [
      { name: 'Planning', category: 'backlog' },
      { name: 'Needs Info', category: 'waiting' },
      { name: 'In Development', category: 'active' },
      { name: 'QA & Review', category: 'active', agentRef: `project:${qa}` },
      { name: 'Done', category: 'done' },
      { name: 'Dismissed', category: 'dismissed' },
    ],
  })
  expect(created.status).toBe(201)
  return created.json.board
}

async function cardOn(b: any, title: string, column = 'Planning') {
  const created = await call('POST', `/boards/${b.id}/items`, { title, column })
  const card = created.json.item
  await db.workItem.update({ where: { id: card.id }, data: { assigneeAgentRef: `project:${dev}` } })
  return card
}

async function place(card: any, columnName: string) {
  const column = await db.boardColumn.findFirst({ where: { boardId: card.boardId, name: columnName } })
  await db.workItem.update({ where: { id: card.id }, data: { columnId: column.id, columnEnteredAt: new Date() } })
}

const events = (card: any, type: string) => db.workItemEvent.findMany({ where: { workItemId: card.id, type } })
const reload = (card: any) => db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
const threadRows = async (card: any): Promise<any[]> => {
  const rows = await db.conversationMessage.findMany({ where: { threadRootId: card.threadRootMessageId }, orderBy: { seq: 'asc' } })
  return rows.map((r: any) => ({ ...r, blocks: typeof r.blocks === 'string' ? JSON.parse(r.blocks) : r.blocks }))
}

/**
 * A reply row as the dispatcher leaves it when its run dies: posted as the
 * agent's placeholder, then settled `error`. This is the path that dropped
 * SHO-84 — the handler was only reachable by hand.
 */
async function replySettlesError(card: any, projectId: string, text = 'Pod error: 409') {
  const posted = await conversation.postMessage({
    conversationId: card.conversationId,
    threadRootId: card.threadRootMessageId,
    authorType: 'agent',
    authorAgentRef: { projectId, name: projectId === qa ? 'QA' : 'Dev' },
    agentStatus: 'running',
    text: 'Thinking…',
  })
  const settled = await conversation.updateMessageInternal(posted.row.id, { agentStatus: 'error', text })
  await pipeline.afterMessagePosted({ ...posted, row: settled.row ?? { ...posted.row, agentStatus: 'error', text } }, { actorUserId: null, origin: 'agent', settled: true })
  return posted.row
}

describe('SHO-84 on the production path', () => {
  test('a reply that settles with an error reaches the handler and re-hands the card', async () => {
    const b = await devBoard('post-hook')
    const card = await cardOn(b, 'Ship the kernel')
    await place(card, 'QA & Review')

    // Nothing calls the handler by hand: the post hook is the entry point.
    await replySettlesError(card, qa)

    const retries = await events(card, 'agent_retry')
    expect(retries).toHaveLength(1)
    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect((await reload(card)).column.name).toBe('QA & Review')

    const line = (await threadRows(card)).find((r) => r.blocks?.cardRetry)
    expect(line?.authorType).toBe('system')
    expect(line.text).toContain('**Re-handed**')
    expect(line.text).toContain(card.key)

    const wakes = await db.agentWake.findMany({ where: { threadRootId: card.threadRootMessageId } })
    expect(wakes).toHaveLength(1)
    expect(wakes[0].reason).toBe('run_died_retry')
    expect(wakes[0].agentRef).toBe(`project:${qa}`)

    // The column agent is the holder that was re-handed (SHO-84's `??` bug).
    await waitFor(() => runsOf(card.key).length === 1, 6000)
    expect(calls[0]!.projectId).toBe(qa)
  }, 30_000)

  test('a run that ends in-process after the same reply does not re-hand twice', async () => {
    const b = await devBoard('post-hook-once')
    const card = await cardOn(b, 'Only once')
    await place(card, 'QA & Review')

    const reply = await replySettlesError(card, qa)
    // The dispatcher's own `finally` then reports the same reply's ending.
    await service.noteCardRunEnded({
      threadRootId: card.threadRootMessageId,
      projectId: qa,
      messageId: reply.id,
      agentStatus: 'error',
      startedAt: new Date(reply.createdAt),
    })

    expect(await events(card, 'agent_retry')).toHaveLength(1)
    expect((await threadRows(card)).filter((r) => r.blocks?.cardRetry)).toHaveLength(1)
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId } })).toBe(1)
  }, 30_000)
})

describe('the Shogo Dev board, whose only waiting column is Needs Info', () => {
  test('a run that dies in Needs Info is re-handed there, then asks a person there', async () => {
    const b = await devBoard('needs-info')
    const card = await cardOn(b, 'Parked with nobody on it')
    await place(card, 'Needs Info')

    await replySettlesError(card, dev)
    expect(await events(card, 'agent_retry')).toHaveLength(1)
    expect((await reload(card)).column.name).toBe('Needs Info')

    await waitFor(() => runsOf(card.key).length === 1, 6000)
    calls[0]!.release('Answered without moving it.')

    const escalated = await waitFor(async () => {
      const rows = await events(card, 'agent_escalated')
      return rows.length ? rows : null
    }, 8000)
    const data = typeof escalated[0].eventData === 'string' ? JSON.parse(escalated[0].eventData) : escalated[0].eventData
    expect(data.reason).toBe('run_died_twice')

    // The card stays where a person looks, and the question is there with it.
    expect((await reload(card)).column.name).toBe('Needs Info')
    const asking = (await threadRows(card)).filter((r) => r.blocks?.cardEscalation)
    expect(asking).toHaveLength(1)
    expect(asking[0].blocks.questions[0].status).toBe('open')
    expect(asking[0].blocks.questions[0].prompt).toContain(card.key)

    await new Promise((r) => setTimeout(r, 600))
    expect(runsOf(card.key)).toHaveLength(1)
  }, 40_000)
})

describe('a run that answers a person on the card', () => {
  /**
   * A person asked on the card and the holder answered — the card's most common
   * exchange. Somebody *is* on the card: it must not be re-handed, and it must
   * never escalate out of its column on the strength of a conversation.
   */
  test('a reply to a person’s comment neither re-hands nor escalates the card', async () => {
    const b = await devBoard('asked-a-person')
    const card = await cardOn(b, 'Someone asked a question')
    await place(card, 'In Development')

    await call('POST', `/conversations/${channelId}/messages`, {
      text: `<@a:p:${dev}> what is blocking you on this one?`,
      threadRootId: card.threadRootMessageId,
    })
    await waitFor(() => calls.length === 1, 5000)
    calls[0]!.release('Nothing is blocking me: I am on the last test.')
    await waitFor(async () => {
      const rows = await threadRows(card)
      return rows.some((r: any) => r.authorType === 'agent' && r.agentStatus === 'done')
    }, 6000)
    await new Promise((r) => setTimeout(r, 1200))

    // The retry run, if one starts, answers too — and would escalate the card.
    if (calls[1]) calls[1].release('Same answer again.')
    await new Promise((r) => setTimeout(r, 1500))

    expect(await events(card, 'agent_retry')).toHaveLength(0)
    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect((await reload(card)).column.name).toBe('In Development')
    expect(calls).toHaveLength(1)
  }, 40_000)
})

describe('a person’s question whose first attempt died', () => {
  /**
   * SHO-84's shape with a person present: they asked, the run errored, the
   * re-hand answered them cleanly. The person now has their answer — the card
   * must not be escalated out of its column on the strength of that.
   */
  test('the retry that answers the person does not escalate the card', async () => {
    const b = await devBoard('asked-then-died')
    const card = await cardOn(b, 'Died on a question')
    await place(card, 'In Development')

    await call('POST', `/conversations/${channelId}/messages`, {
      text: `<@a:p:${dev}> where is this at?`,
      threadRootId: card.threadRootMessageId,
    })
    await waitFor(() => calls.length === 1, 5000)
    calls[0]!.fail()

    // The failure is noticed and the card is re-handed.
    await waitFor(async () => (await events(card, 'agent_retry')).length === 1, 10_000)
    await waitFor(() => calls.length === 2, 10_000)
    calls[1]!.release('One test left, then it is in QA.')
    await new Promise((r) => setTimeout(r, 2000))

    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect((await reload(card)).column.name).toBe('In Development')
    expect(calls).toHaveLength(2)
  }, 40_000)
})

describe('the escalation keep SHO-88’s card-watch fields', () => {
  /**
   * SHO-88 (#1580) put `assigneeAgentRef` / `columnAgentRef` on the events that
   * move a card, so a watch stays with it. This branch rewrote those call sites,
   * so an escalation that lands without them silently drops the watcher.
   */
  test('agent_escalated and its move both carry the holder refs', async () => {
    const b = await devBoard('watch-fields')
    const card = await cardOn(b, 'Escalate with a watcher')
    await place(card, 'In Development')

    await replySettlesError(card, dev, 'first death')
    await waitFor(() => runsOf(card.key).length === 1, 6000)
    calls[0]!.release('Answered without moving it.')
    await waitFor(async () => (await events(card, 'agent_escalated')).length === 1, 8000)

    const parsed = (r: any) => (typeof r.eventData === 'string' ? JSON.parse(r.eventData) : r.eventData)
    const escalated = parsed((await events(card, 'agent_escalated'))[0])
    expect(escalated.assigneeAgentRef).toBe(`project:${dev}`)
    expect(escalated.columnAgentRef).toBeNull()

    const moved = (await db.workItemEvent.findMany({ where: { workItemId: card.id, type: 'moved' }, orderBy: { createdAt: 'desc' } }))
      .map(parsed)
      .find((d: any) => d?.reason === 'agent_escalated')
    expect(moved).toBeTruthy()
    expect(moved.assigneeAgentRef).toBe(`project:${dev}`)
    expect(moved.columnAgentRef).toBeNull()
    expect(moved.to.category).toBe('waiting')
    expect((await reload(card)).column.name).toBe('Needs Info')
  }, 40_000)
})
