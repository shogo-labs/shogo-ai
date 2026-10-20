// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A run that dies leaves nobody on its card. The card has to be noticed (both
 * when its assignee's run dies and when the column agent's does), re-handed to
 * its agent once with a backoff, and — if that run also ends without progress —
 * escalated to a person with a reason and one question they can act on.
 *
 * SQLite harness, real routes, and the wake left to the real coalesce timer
 * (nothing here calls `enqueueAgentWake` by hand).
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
const questions = await import('../services/conversation-message-kind')

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

interface Run {
  projectId: string | null
  prompt: string
  release: (text: string) => void
}
let calls: Run[] = []

/** Runs one card's wakes produced, whatever else is in flight. */
const runsOf = (key: string) => calls.filter((c) => c.prompt.includes(`work_item_get("${key}")`))

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  dev = (await db.project.create({ data: { name: 'Dev', workspaceId: seed.workspaceId } })).id
  qa = (await db.project.create({ data: { name: 'QA', workspaceId: seed.workspaceId } })).id
  const created = await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'dev-board' })
  channelId = created.json.conversation.id
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

/** Backlog / In progress / QA & Review (bound to QA) / Needs attention / Done / Dismissed. */
async function board(name: string) {
  const created = await call('POST', `/workspaces/${seed.workspaceId}/boards`, {
    conversationId: channelId,
    name,
    columns: [
      { name: 'Backlog', category: 'backlog' },
      { name: 'In progress', category: 'active' },
      { name: 'QA & Review', category: 'active', agentRef: `project:${qa}` },
      { name: 'Needs attention', category: 'waiting' },
      { name: 'Done', category: 'done' },
      { name: 'Dismissed', category: 'dismissed' },
    ],
  })
  expect(created.status).toBe(201)
  return created.json.board
}

/**
 * A card the dev owns. The assignment is written straight to the row — a card
 * created with `assigneeAgentRef` wakes the agent, and that run's own ending
 * would be the first thing this file measured.
 */
async function cardOn(b: any, title: string, column = 'Backlog') {
  const created = await call('POST', `/boards/${b.id}/items`, { title, column })
  const card = created.json.item
  await db.workItem.update({ where: { id: card.id }, data: { assigneeAgentRef: `project:${dev}` } })
  expect(runsOf(card.key)).toHaveLength(0)
  return card
}

/**
 * The shape from SHO-84: the card carries an assignee (dev) *and* sits in a
 * column bound to another agent (QA), so `assignee ?? column` would hide QA's
 * death.
 */
async function inQaReview(card: any) {
  const column = await db.boardColumn.findFirst({ where: { boardId: card.boardId, name: 'QA & Review' } })
  await db.workItem.update({ where: { id: card.id }, data: { columnId: column.id, columnEnteredAt: new Date() } })
}

/** A reply row that settled with an error, as a dead run leaves it. */
async function failedReply(card: any, projectId: string, text = 'Pod error: 409'): Promise<any> {
  return db.conversationMessage.create({
    data: {
      conversationId: card.conversationId,
      workspaceId: seed.workspaceId,
      seq: 9_000 + Math.floor(Math.random() * 100_000),
      threadRootId: card.threadRootMessageId,
      authorType: 'agent',
      authorAgentRef: { projectId, name: projectId === qa ? 'QA' : 'Dev' },
      agentStatus: 'error',
      text,
    },
  })
}

const events = (card: any, type: string) => db.workItemEvent.findMany({ where: { workItemId: card.id, type } })
const reload = (card: any) => db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
const blockRows = async (card: any): Promise<any[]> => {
  const rows = await db.conversationMessage.findMany({ where: { threadRootId: card.threadRootMessageId }, orderBy: { seq: 'asc' } })
  return rows.map((r: any) => ({ ...r, blocks: typeof r.blocks === 'string' ? JSON.parse(r.blocks) : r.blocks }))
}

describe('a run that dies with nobody else on the card', () => {
  test('SHO-84: the column agent’s death is noticed, the card is re-handed once, and the retry runs', async () => {
    const b = await board('replay')
    const card = await cardOn(b, 'Ship the kernel')
    await inQaReview(card)
    const failed = await failedReply(card, qa)

    await service.noteCardRunEnded({
      threadRootId: card.threadRootMessageId,
      projectId: qa,
      messageId: failed.id,
      agentStatus: 'error',
      startedAt: new Date(failed.createdAt),
    })

    // The card did not move, and a person was not asked anything yet.
    expect((await reload(card)).column.name).toBe('QA & Review')
    expect(await events(card, 'agent_retry')).toHaveLength(1)
    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect((await blockRows(card)).filter((r) => r.blocks?.questions?.length)).toHaveLength(0)

    // One line in the thread, one wake row, still inside its backoff.
    const line = (await blockRows(card)).find((r) => r.blocks?.cardRetry)
    expect(line?.authorType).toBe('system')
    expect(line.text).toContain('**Re-handed**')
    expect(line.text).toContain(card.key)
    expect(line.blocks.cardRetry.agentRef).toBe(`project:${qa}`)
    const wakes = await db.agentWake.findMany({ where: { threadRootId: card.threadRootMessageId } })
    expect(wakes).toHaveLength(1)
    expect(wakes[0].reason).toBe('run_died_retry')
    expect(wakes[0].agentRef).toBe(`project:${qa}`)
    expect(new Date(wakes[0].notBefore).getTime()).toBeGreaterThan(Date.now())

    // After the backoff the wake starts exactly one run, with the card's state in it.
    await waitFor(() => runsOf(card.key).length === 1, 6000)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toContain(card.key)
    expect(calls[0]!.prompt).toContain('QA & Review')
    expect(calls[0]!.prompt).toContain('without moving the card')
    expect(await db.agentWake.findFirst({ where: { threadRootId: card.threadRootMessageId } })).toBeTruthy()
  })

  test('a second stranded ending escalates: no second retry, no run, one question for a person', async () => {
    const b = await board('bounce')
    const card = await cardOn(b, 'Bounces once')
    await inQaReview(card)
    const failed = await failedReply(card, qa)

    await service.noteCardRunEnded({
      threadRootId: card.threadRootMessageId,
      projectId: qa,
      messageId: failed.id,
      agentStatus: 'error',
      startedAt: new Date(failed.createdAt),
    })
    await waitFor(() => runsOf(card.key).length === 1, 6000)
    // The retry run ends the same way: nothing moved, nothing asked.
    calls[0]!.release('I looked at it and stopped.'.repeat(1))

    const escalated = await waitFor(async () => {
      const rows = await events(card, 'agent_escalated')
      return rows.length ? rows : null
    }, 6000)
    const data = typeof escalated[0].eventData === 'string' ? JSON.parse(escalated[0].eventData) : escalated[0].eventData
    expect(data.reason).toBe('run_died_twice')
    // The reply that died second is the retry run's own; the line it was handed
    // is the link back to the first death.
    const line = (await blockRows(card)).find((r) => r.blocks?.cardRetry)
    expect(data.retryMessageId).toBe(line.id)

    // Moved to the column that means a person must look, and no third run.
    expect((await reload(card)).column.name).toBe('Needs attention')
    await new Promise((r) => setTimeout(r, 600))
    expect(runsOf(card.key)).toHaveLength(1)
    expect(await events(card, 'agent_retry')).toHaveLength(1)

    // One question, three options, addressed to the card's owner.
    const asking = (await blockRows(card)).filter((r) => r.blocks?.cardEscalation)
    expect(asking).toHaveLength(1)
    expect(asking[0].blocks.questions).toHaveLength(1)
    const question = asking[0].blocks.questions[0]
    expect(question.status).toBe('open')
    expect(question.options.map((o: any) => o.label)).toEqual(['Retry it', "I'll take it", 'Dismiss'])
    expect(question.to.userIds).toEqual([seed.member])
    expect(question.prompt).toContain(card.key)
  }, 30_000)

  test('the escalation question is unanswered → nothing else runs, and a later run is not re-handled', async () => {
    const b = await board('quiet')
    const card = await cardOn(b, 'Ask once')
    await inQaReview(card)
    const failed = await failedReply(card, qa)

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error' })
    // The handler is called again for the same reply (post hook + run end): still one retry.
    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error' })

    expect(await events(card, 'agent_retry')).toHaveLength(1)
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId } })).toBe(1)
    expect((await blockRows(card)).filter((r) => r.blocks?.cardRetry)).toHaveLength(1)
  })
})

describe('when the run did hand the card on', () => {
  test('a run that moved the card is left alone', async () => {
    const b = await board('moved')
    const card = await cardOn(b, 'Moved on')
    await inQaReview(card)
    const startedAt = new Date(Date.now() - 60_000)
    await call('POST', `/work-items/${card.id}/move`, { column: 'In progress' })
    const failed = await failedReply(card, qa)

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error', startedAt })
    expect(await events(card, 'agent_retry')).toHaveLength(0)
    expect((await reload(card)).column.name).toBe('In progress')
  })

  test('a run that asked a question is left alone', async () => {
    const b = await board('asked')
    const card = await cardOn(b, 'Asked first')
    await inQaReview(card)
    const startedAt = new Date(Date.now() - 60_000)
    const failed = await failedReply(card, qa)
    await db.conversationMessage.create({
      data: {
        conversationId: card.conversationId,
        workspaceId: seed.workspaceId,
        seq: 88_001,
        threadRootId: card.threadRootMessageId,
        authorType: 'agent',
        authorAgentRef: { projectId: qa, name: 'QA' },
        agentStatus: 'done',
        text: 'Which branch?',
        blocks: {
          questions: [{
            id: 'q-asked', to: { userIds: [seed.member], via: 'thread' }, header: 'Branch', prompt: 'Which branch?',
            interaction: 'text', status: 'open', source: 'agent', askCount: 1, lastAskedAt: new Date().toISOString(),
          }],
        },
      },
    })

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error', startedAt })
    expect(await events(card, 'agent_retry')).toHaveLength(0)
  })

  test('a run a person stopped records agent_stopped and nothing else', async () => {
    const b = await board('stopped')
    const card = await cardOn(b, 'Stopped by hand')
    await inQaReview(card)
    const stopped = await failedReply(card, qa)
    await db.conversationMessage.update({ where: { id: stopped.id }, data: { agentStatus: 'stopped' } })

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: stopped.id, agentStatus: 'stopped' })
    expect(await events(card, 'agent_stopped')).toHaveLength(1)
    expect(await events(card, 'agent_retry')).toHaveLength(0)
    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId } })).toBe(0)
  })

  test('a bystander agent’s run on the thread is not the card’s business', async () => {
    const b = await board('bystander')
    const card = await cardOn(b, 'Not yours')
    await inQaReview(card)
    const other = await db.project.create({ data: { name: 'Other', workspaceId: seed.workspaceId } })
    const failed = await failedReply(card, other.id)

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: other.id, messageId: failed.id, agentStatus: 'error' })
    expect(await events(card, 'agent_retry')).toHaveLength(0)
    expect(await events(card, 'agent_failed')).toHaveLength(0)
  })

  test('another run still live in the thread holds the card: no re-hand', async () => {
    const b = await board('live')
    const card = await cardOn(b, 'Someone else is on it')
    await inQaReview(card)
    const failed = await failedReply(card, qa)
    await db.conversationMessage.create({
      data: {
        conversationId: card.conversationId,
        workspaceId: seed.workspaceId,
        seq: 88_002,
        threadRootId: card.threadRootMessageId,
        authorType: 'agent',
        authorAgentRef: { projectId: dev, name: 'Dev' },
        agentStatus: 'running',
        text: '',
      },
    })

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error' })
    expect(await events(card, 'agent_retry')).toHaveLength(0)
  })
})

describe('when a person is in the thread', () => {
  test('a run that answered a person is not re-handed, and the card stays put', async () => {
    const b = await board('person')
    const card = await cardOn(b, 'What is blocking you?')

    await call('POST', `/conversations/${channelId}/messages`, {
      text: `<@a:p:${dev}> what is blocking you on this one?`,
      threadRootId: card.threadRootMessageId,
    })
    await waitFor(() => calls.length === 1, 4000)
    calls[0]!.release('Nothing is blocking me: I am on the last test.')
    // The run ended cleanly against the person's question, without moving the card.
    await waitFor(async () => (await events(card, 'agent_stopped')).length === 1, 6000)
    await new Promise((r) => setTimeout(r, 700))

    expect(calls).toHaveLength(1)
    expect(await events(card, 'agent_retry')).toHaveLength(0)
    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect((await reload(card)).column.name).toBe('Backlog')
  }, 20_000)

  test('a run that failed after a person asked is still re-handed: the person got an error', async () => {
    const b = await board('asked-then-died')
    const card = await cardOn(b, 'Died on a question')
    await db.conversationMessage.create({
      data: {
        conversationId: card.conversationId,
        workspaceId: seed.workspaceId,
        seq: 91_000,
        threadRootId: card.threadRootMessageId,
        authorType: 'user',
        authorUserId: seed.member,
        text: 'Where is this at?',
      },
    })
    const failed = await failedReply(card, dev)

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: dev, messageId: failed.id, agentStatus: 'error' })
    expect(await events(card, 'agent_retry')).toHaveLength(1)
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId, status: 'pending' } })).toBe(1)
  })

  test('the retry that answers the person does not escalate the card', async () => {
    const b = await board('asked-then-retried')
    const card = await cardOn(b, 'First attempt died, retry answered')
    const t0 = Date.now() - 60_000
    const row = (seq: number, extra: Record<string, unknown>, at: number) => db.conversationMessage.create({
      data: {
        conversationId: card.conversationId,
        workspaceId: seed.workspaceId,
        seq,
        threadRootId: card.threadRootMessageId,
        createdAt: new Date(at),
        ...extra,
      },
    })
    await row(91_100, { authorType: 'user', authorUserId: seed.member, text: 'where is this at?' }, t0)
    const first = await row(91_101, {
      authorType: 'agent',
      authorAgentRef: { projectId: dev },
      agentStatus: 'error',
      text: 'This reply was interrupted because the server restarted.',
    }, t0 + 1_000)
    // The first attempt died, so the card was already re-handed once.
    await db.workItemEvent.create({
      data: { workItemId: card.id, workspaceId: seed.workspaceId, type: 'agent_retry', eventData: { messageId: first.id } },
    })
    const retry = await row(91_102, {
      authorType: 'agent',
      authorAgentRef: { projectId: dev },
      agentStatus: 'done',
      text: 'One test left, then it is in QA.',
    }, t0 + 2_000)

    await service.noteCardRunEnded({
      threadRootId: card.threadRootMessageId,
      projectId: dev,
      messageId: retry.id,
      agentStatus: 'done',
      startedAt: new Date(t0 + 2_000),
    })

    // The failed row is not the agent's last word: a person asked, and this run answered them.
    expect(await events(card, 'agent_escalated')).toHaveLength(0)
    expect((await reload(card)).column.name).toBe('Backlog')
  })
})

describe('a person re-waking the agent inside the backoff', () => {
  test('supersedes the re-hand, so the window closes with exactly one run', async () => {
    const b = await board('supersede')
    const card = await cardOn(b, 'Tagged instead')
    await inQaReview(card)
    const failed = await failedReply(card, qa)

    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error' })
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId, status: 'pending' } })).toBe(1)

    // A person tags QA in the same window: that wake carries the instruction.
    await call('POST', `/conversations/${channelId}/messages`, {
      text: `<@a:p:${qa}> please pick this back up`,
      threadRootId: card.threadRootMessageId,
    })
    await waitFor(() => runsOf(card.key).length === 1, 3000)
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId, status: 'superseded' } })).toBe(1)

    // Nothing fires when the window closes.
    await new Promise((r) => setTimeout(r, 900))
    expect(runsOf(card.key)).toHaveLength(1)
    expect(calls).toHaveLength(1)
  }, 20_000)
})

describe('a run whose process died', () => {
  // A reply a previous test left `running` in some card thread is a dead run by
  // this sweep's rules too; settle those first, so each test counts its own.
  beforeEach(async () => {
    await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  })

  /** A card thread, and a reply row left `running` with a turn that stopped heartbeating. */
  async function deadRun(name: string, opts: { heartbeats?: boolean } = {}) {
    const b = await board(name)
    const card = await cardOn(b, `Dead run ${name}`)
    await inQaReview(card)
    const session = await db.chatSession.create({
      data: {
        inferredName: 'qa run',
        contextType: 'workspace',
        workspaceId: seed.workspaceId,
        createdByUserId: seed.owner,
        activeTurnId: 'turn-1',
        activeTurnStartedAt: new Date(),
        activeTurnHeartbeatAt: opts.heartbeats ? new Date() : new Date(Date.now() - 3_600_000),
      },
    })
    const row = await db.conversationMessage.create({
      data: {
        conversationId: card.conversationId,
        workspaceId: seed.workspaceId,
        seq: 9_000 + Math.floor(Math.random() * 100_000),
        threadRootId: card.threadRootMessageId,
        authorType: 'agent',
        authorAgentRef: { projectId: qa, name: 'QA' },
        agentSessionId: session.id,
        agentStatus: 'running',
        text: 'Starting up…',
      },
    })
    return { card, row }
  }

  test('is settled without a restart, once, and its card is re-handed', async () => {
    const { card, row } = await deadRun('sweep')
    expect(await dispatcher.sweepDeadAgentReplies()).toBe(1)
    const settled = await db.conversationMessage.findUnique({ where: { id: row.id } })
    expect(settled.agentStatus).toBe('error')
    expect(settled.text).toContain('heartbeats')
    expect(await events(card, 'agent_retry')).toHaveLength(1)

    // A second sweep finds nothing to do — the compare-and-set already flipped it.
    expect(await dispatcher.sweepDeadAgentReplies()).toBe(0)
    expect(await events(card, 'agent_retry')).toHaveLength(1)
  })

  test('two concurrent sweeps settle it once', async () => {
    const { row } = await deadRun('race')
    const results = await Promise.all([dispatcher.sweepDeadAgentReplies(), dispatcher.sweepDeadAgentReplies()])
    expect(results.reduce((a, b) => a + b, 0)).toBe(1)
    expect((await db.conversationMessage.findUnique({ where: { id: row.id } })).agentStatus).toBe('error')
  })

  test('a fresh heartbeat, or a run this pod is writing, is never touched', async () => {
    const fresh = await deadRun('fresh', { heartbeats: true })
    expect(await dispatcher.sweepDeadAgentReplies()).toBe(0)
    expect((await db.conversationMessage.findUnique({ where: { id: fresh.row.id } })).agentStatus).toBe('running')

    // A run this pod is holding: its placeholder exists while `invoke` is open.
    const b = await board('held')
    const card = await cardOn(b, 'Held here')
    await call('POST', `/conversations/${channelId}/messages`, {
      text: `<@a:p:${dev}> take this`,
      threadRootId: card.threadRootMessageId,
    })
    await waitFor(() => calls.length === 1, 3000)
    expect(await dispatcher.sweepDeadAgentReplies()).toBe(0)
    calls[0]!.release('On it.')
  })
})

describe('answering the escalation question', () => {
  /** A card escalated through both deaths, ready for a person to choose. */
  async function escalated(name: string) {
    const b = await board(name)
    const card = await cardOn(b, `Escalate ${name}`)
    await inQaReview(card)
    const failed = await failedReply(card, qa)
    await service.noteCardRunEnded({ threadRootId: card.threadRootMessageId, projectId: qa, messageId: failed.id, agentStatus: 'error' })
    await waitFor(() => runsOf(card.key).length === 1, 6000)
    calls[0]!.release('Stopped again.')
    const asking = await waitFor(async () => {
      const rows = (await blockRows(card)).filter((r) => r.blocks?.cardEscalation)
      return rows.length ? rows[0] : null
    }, 6000)
    calls = []
    return { card, messageId: asking.id as string, questionId: asking.blocks.questions[0].id as string }
  }

  test('“Retry it” wakes the holder once more', async () => {
    const { card, messageId, questionId } = await escalated('retry')
    const answer = await call('POST', `/conversation-messages/${messageId}/questions/${questionId}/answer`, { answer: 'Retry it' })
    expect(answer.status).toBe(200)
    await waitFor(() => runsOf(card.key).length === 1, 6000)
    expect(calls[0]!.projectId).toBe(qa)
    const closed = (await blockRows(card)).find((r) => r.id === messageId)
    expect(closed.blocks.questions[0].status).toBe('answered')
    // No generic question relay: the answer is the action, not a message to an agent.
    expect(await db.agentWake.count({ where: { threadRootId: card.threadRootMessageId, status: 'pending' } })).toBe(0)
  })

  test('“I’ll take it” assigns the person and runs nobody', async () => {
    const { card, messageId, questionId } = await escalated('take')
    const answer = await call('POST', `/conversation-messages/${messageId}/questions/${questionId}/answer`, { answer: "I'll take it" })
    expect(answer.status).toBe(200)
    const after = await db.workItem.findUnique({ where: { id: card.id } })
    expect(after.assigneeUserId).toBe(seed.member)
    expect(after.assigneeAgentRef).toBeNull()
    await new Promise((r) => setTimeout(r, 600))
    expect(calls).toHaveLength(0)
  })

  test('“Dismiss” moves the card to Dismissed', async () => {
    const { card, messageId, questionId } = await escalated('dismiss')
    const answer = await call('POST', `/conversation-messages/${messageId}/questions/${questionId}/answer`, { answer: 'Dismiss' })
    expect(answer.status).toBe(200)
    expect((await reload(card)).column.name).toBe('Dismissed')
    expect(await events(card, 'agent_retry')).toHaveLength(1)
  })
})

describe('the predicate and the answer mapping, on their own', () => {
  const item = {
    id: 'card-1',
    column: { id: 'col-qa', name: 'QA & Review', category: 'active' },
    assigneeAgentRef: `project:${'dev-project'}`,
    column_agent_placeholder: undefined,
  }

  test('the holder union is what decides who may strand the card', async () => {
    const check = await service.strandedFor(
      { ...item, column: { ...item.column, agentRef: `project:qa-project` } },
      { threadRootId: 'root-with-no-messages', projectId: 'qa-project', messageId: 'm-qa', agentStatus: 'done', startedAt: new Date() },
    )
    expect(check).toEqual({ stranded: true, agentRef: 'project:qa-project', since: expect.any(Date) })
  })

  test('closed columns, a person’s stop and a bystander are not stranded', async () => {
    const done = await service.strandedFor(
      { ...item, column: { name: 'Done', category: 'done' } },
      { threadRootId: null, projectId: 'dev-project', messageId: 'm-1', agentStatus: 'error' },
    )
    expect(done).toEqual({ stranded: false, reason: 'terminal' })

    const stopped = await service.strandedFor(item, {
      threadRootId: null, projectId: 'dev-project', messageId: 'm-2', agentStatus: 'stopped',
    })
    expect(stopped).toEqual({ stranded: false, reason: 'stopped_by_person' })

    const bystander = await service.strandedFor(item, {
      threadRootId: null, projectId: 'someone-else', messageId: 'm-3', agentStatus: 'error',
    })
    expect(bystander).toEqual({ stranded: false, reason: 'not_a_holder' })
  })

  test('an answer maps to a choice, and a free-typed answer maps to none', () => {
    expect(service.escalationChoice('Retry it')).toBe('retry')
    expect(service.escalationChoice("I'll take it")).toBe('take')
    expect(service.escalationChoice('Dismiss')).toBe('dismiss')
    expect(service.escalationChoice('let me think about it')).toBe('other')
  })

  test('blocks.cardEscalation and blocks.cardRetry round-trip through the stored JSON', async () => {
    const b = await board('blocks')
    const card = await cardOn(b, 'Stored blocks')
    const escalation = { itemId: card.id, agentRef: `project:${qa}`, reason: 'run_died_twice' as const }
    const row = await db.conversationMessage.create({
      data: {
        conversationId: card.conversationId, workspaceId: seed.workspaceId, seq: 88_100,
        threadRootId: card.threadRootMessageId, authorType: 'system', text: 'needs a person',
        blocks: { questions: [{ id: 'q-1', prompt: 'Who takes it?', status: 'open' }], cardEscalation: escalation },
      },
    })
    const stored = await db.conversationMessage.findUnique({ where: { id: row.id } })
    const parsed = typeof stored.blocks === 'string' ? JSON.parse(stored.blocks) : stored.blocks
    expect(parsed.cardEscalation).toEqual(escalation)
    expect(questions.questionsOf(stored.blocks)[0].id).toBe('q-1')
  })
})
