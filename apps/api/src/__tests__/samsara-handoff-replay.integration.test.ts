// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Replays the Samsara Phase 1 hand-offs from production (2026-10-16): the
 * workspace agent (Shogo) hands cards to a Backend and a UE engineer and
 * watches them; the owner's standing rule has each engineer move a finished
 * card to Review, comment the evidence and tag @Shogo in the card's thread.
 *
 * Everything runs through the real board routes, chat routes, dispatcher and
 * background tasks; only the agents' model turns are scripted (the texts are
 * the engineers' own from the logs). What must hold:
 *  - a finished card wakes Shogo's main session once, with the engineer's
 *    comment in the update, and never also runs Shogo in the card thread;
 *  - a bounced card runs the engineer once, and its fix comes back the same way;
 *  - both lanes finishing together still mean no thread runs for Shogo;
 *  - outside card threads tags run as before, and a runaway thank-you loop is
 *    stopped by the backstop limit, not earlier.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  projectChatRoutes: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
}))

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const { agentBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const tasks = await import('../services/background-tasks.service')
const { MAX_AGENT_PING_PONG_TURNS } = await import('../services/conversation-agent-chain')

const db = prisma as any
let seed: SeededWorkspace
let backend: string
let ue: string
/** Who the internal routes treat as the caller (null: the workspace agent). */
let actor: string | null = null

interface Invocation { projectId: string | null; sessionId: string; prompt: string }
let invocations: Invocation[] = []
let scripts: Record<string, (inv: Invocation) => string | Promise<string>> = {}

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({ authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: actor }) }))
app.route('/api/internal', agentBoardRoutes({ authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: actor ?? undefined }) }))

async function call(method: string, path: string, body?: unknown, user?: string) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** A board call made as `as` (an engineer's project id, or null for Shogo). */
async function asAgent(as: string | null, method: string, path: string, body?: unknown) {
  const before = actor
  actor = as
  try {
    return await call(method, `/internal/workspaces/${seed.workspaceId}${path}`, body)
  } finally {
    actor = before
  }
}

const HANDOFF_WATCH_UNTIL = 'moved to [^\\n]*\\((review|waiting|done|dismissed)\\)|(^|\\n)agent (stopped|failed)'
const SHOGO = '<@a:ws>'
const tagOf = (projectId: string) => `<@a:p:${projectId}>`

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  backend = (await db.project.create({ data: { name: 'Samsara Backend Engineer', workspaceId: seed.workspaceId } })).id
  ue = (await db.project.create({ data: { name: 'Samsara UE Engineer', workspaceId: seed.workspaceId } })).id
})

beforeEach(() => {
  invocations = []
  scripts = {}
  actor = null
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      const inv = { projectId: args.projectId, sessionId: args.sessionId, prompt: args.prompt }
      invocations.push(inv)
      const text = await (scripts[args.projectId ?? 'ws']?.(inv) ?? 'ok')
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterEach(() => tasks._testing.clearTimers())

afterAll(async () => {
  tasks._testing.clearTimers()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

let boards = 0

/** #samsara-phase1 with a Phase 1 board, and Shogo's main session (the one that hands cards out). */
async function phase1() {
  const name = `samsara-phase1-${++boards}`
  const created = await call('POST', `/workspaces/${seed.workspaceId}/conversations`, { name }, seed.owner)
  expect(created.status).toBe(201)
  const conversationId = created.json.conversation.id as string
  for (const projectId of [backend, ue]) {
    await db.conversationMember.create({ data: { conversationId, memberType: 'agent', projectId } }).catch(() => {})
  }
  const board = await asAgent(null, 'POST', '/agent-boards', {
    channel: `#${name}`, name: 'Phase 1',
    columns: [
      { name: 'Backlog', category: 'backlog' }, { name: 'In progress', category: 'active' },
      { name: 'Review', category: 'review' }, { name: 'Done', category: 'done' },
    ],
  })
  expect(board.status).toBe(201)
  const main = await db.chatSession.create({
    data: { inferredName: 'Shogo', contextType: 'workspace', workspaceId: seed.workspaceId, createdByUserId: seed.owner },
  })
  return { conversationId, slug: board.json.board.slug as string, main: main.id as string }
}

/**
 * Shogo hands a card to an engineer and watches it, as the board tools do on a
 * hand-off. The engineer's turn (`work`, given the card key) starts only once
 * the watch exists: a real turn takes minutes, a scripted one does not.
 */
async function handOff(ctx: { slug: string; main: string }, title: string, engineer: string, work: (key: string) => Promise<string>) {
  let open!: () => void
  const watching = new Promise<void>((r) => { open = r })
  let key = ''
  scripts[engineer] = async () => { await watching; return work(key) }
  const card = await asAgent(null, 'POST', `/agent-boards/${ctx.slug}/items`, { title, column: 'In progress', assignee_agent: `project:${engineer}` })
  expect(card.status).toBe(201)
  key = card.json.item.key
  const item = await db.workItem.findUnique({ where: { id: card.json.item.id } })
  const watch = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId: ctx.main, source: 'work_item', targetRef: item.id, title: `${item.key} ${title}`, until: HANDOFF_WATCH_UNTIL })
  open()
  return { key, item, watch }
}

/** The engineer's turn under the standing rule: move to Review, comment the evidence, end the reply with @Shogo. */
function finishesAndTagsShogo(projectId: string, evidence: (key: string) => string) {
  return async (key: string) => {
    await asAgent(projectId, 'POST', `/agent-work-items/${key}/move`, { column: 'Review' })
    await asAgent(projectId, 'POST', `/agent-work-items/${key}/comments`, { text: evidence(key) })
    return `${evidence(key)} ${SHOGO}`
  }
}

async function quiet(ms = 200) {
  await new Promise((r) => setTimeout(r, ms))
  await waitFor(async () => !(await db.conversationMessage.findFirst({ where: { agentStatus: 'running' } })), 10_000)
  await new Promise((r) => setTimeout(r, 50))
}

const runsOf = (projectId: string | null) => invocations.filter((i) => i.projectId === projectId)

/** The wake Shogo's main session would get now: the [Task update] text, or null. */
async function wakeText(main: string): Promise<string | null> {
  tasks._testing.clearTimers()
  await tasks.enqueueTaskWake(main)
  const row = await db.chatQueuedMessage.findFirst({ where: { sessionId: main, kind: 'task_notification' }, orderBy: { createdAt: 'desc' } })
  return row?.content ?? null
}

describe('Samsara Phase 1 replay: engineers tag @Shogo when a card is done', () => {
  test('P1-4: the finish wakes Shogo once with the evidence, and Shogo is not also run in the card thread', async () => {
    const ctx = await phase1()
    const card = await handOff(ctx, 'M0.4 gates 11 and 12', backend, finishesAndTagsShogo(backend, (key) =>
      `${key} is in Review at b6d4123: \`bun test\` 412 pass, \`tsc\` clean, gate 12 shutdown test sends a real SIGTERM. Report: docs/phase1/reports/p1-4.md.`))
    await quiet()

    expect(runsOf(backend)).toHaveLength(1)
    expect(runsOf(null)).toHaveLength(0)
    const watch = await tasks.getTask(card.watch.id)
    expect(watch!.status).toBe('completed')
    expect(watch!.heldUntil).toBeNull()
    const wake = await wakeText(ctx.main)
    expect(wake).toContain(`[Task update] ${card.key}`)
    expect(wake).toContain('moved to Review (review)')
    expect(wake).toContain('b6d4123')
    expect(await db.chatQueuedMessage.count({ where: { sessionId: ctx.main, kind: 'task_notification' } })).toBe(1)
  })

  test('P1-7: a bounce runs the UE engineer once, and its fix comes back as one more update', async () => {
    const ctx = await phase1()
    let round = 0
    const work = finishesAndTagsShogo(ue, (key) => round === 1
      ? `${key} in Review at ab1b896: 2 joins, 150/148 remote-action samples, 0 asserts; the 1-client control fails as it should. Report: Docs/reports/2026-10-16-p1-7-acf-net-spike.md.`
      : `Fixed the citation: the HasAuthority() gate in ACFCharacter::TakeDamage is at :586. ${key} back in Review at c3d09e1.`)
    const card = await handOff(ctx, 'M1.1 ACF spike: server + 2 clients on 5.8 at 150 ms', ue, (key) => { round++; return work(key) })
    await quiet()
    expect(runsOf(ue)).toHaveLength(1)
    expect(await wakeText(ctx.main)).toContain('ab1b896')

    // Shogo reviews from its main session: wrong citation, so back to In progress with the fix on the card.
    const rewatch = await tasks.createTask({ id: tasks.newTaskId(), chatSessionId: ctx.main, source: 'work_item', targetRef: card.item.id, title: card.key, until: HANDOFF_WATCH_UNTIL })
    await asAgent(null, 'POST', `/agent-work-items/${card.key}/move`, { column: 'In progress' })
    await asAgent(null, 'POST', `/agent-work-items/${card.key}/comments`, {
      text: `${tagOf(ue)} everything checks out except one citation: the HasAuthority() gate is at ACFCharacter.cpp:586, not :584. Fix it and move P1-7 back to Review.`,
    })
    await quiet()

    expect(runsOf(ue)).toHaveLength(2)
    expect(runsOf(null)).toHaveLength(0)
    const fixed = await tasks.getTask(rewatch.id)
    expect(fixed!.heldUntil).toBeNull()
    expect(fixed!.output).toContain(':586')
  })

  test('both lanes finishing together wake Shogo with both cards and run it in neither thread', async () => {
    const ctx = await phase1()
    const p14 = await handOff(ctx, 'M0.4 gates 11 and 12', backend, finishesAndTagsShogo(backend, (key) => `${key} in Review at b6d4123, 412 tests pass.`))
    const p17 = await handOff(ctx, 'M1.1 ACF spike', ue, finishesAndTagsShogo(ue, (key) => `${key} in Review at ab1b896, 2 joins at 150 ms.`))
    await quiet()

    expect(runsOf(backend)).toHaveLength(1)
    expect(runsOf(ue)).toHaveLength(1)
    expect(runsOf(null)).toHaveLength(0)
    const wake = await wakeText(ctx.main)
    expect(wake).toContain('b6d4123')
    expect(wake).toContain('ab1b896')
  })
})

describe('Samsara Phase 1 replay: tags outside card threads', () => {
  test('the "Recorded, and applied" replies to the standing rule run Shogo in that thread, and the chain ends when it does not tag back', async () => {
    const ctx = await phase1()
    scripts[backend] = () => `Recorded, and applied to P1-4. The line I saved: "When a card is done, tag ${SHOGO} in its thread." ${SHOGO}`
    scripts[ue] = () => `Saved to my AGENTS.md under How you work. ${SHOGO}`
    scripts.ws = () => 'Both engineers saved the rule; P1-4 and P1-7 carry on.'
    actor = null
    const posted = await call('POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/${(await db.conversation.findUnique({ where: { id: ctx.conversationId } })).name}/messages`, {
      text: `${tagOf(backend)} ${tagOf(ue)} New standing rule from Russell: when you finish a card, move it to Review, comment the evidence and tag me (${SHOGO}) in that card's thread.`,
    })
    expect(posted.status).toBeLessThan(300)
    await quiet(400)

    expect(runsOf(backend)).toHaveLength(1)
    expect(runsOf(ue)).toHaveLength(1)
    expect(runsOf(null).length).toBeGreaterThanOrEqual(1)
    expect(runsOf(null).length).toBeLessThanOrEqual(2)
    expect(runsOf(null)[0].prompt).toContain('Agents tagging each other can loop')
  })

  test('a runaway thank-you loop is stopped by the backstop, only after many rounds', async () => {
    const ctx = await phase1()
    scripts[backend] = () => `Thanks ${SHOGO}!`
    scripts.ws = () => `Thank you ${tagOf(backend)}!`
    const root = await call('POST', `/conversations/${ctx.conversationId}/messages`, { text: `${tagOf(backend)} thanks for P1-4` }, seed.owner)
    expect(root.status).toBe(201)
    const paused = await waitFor(async () => db.conversationMessage.findFirst({
      where: { conversationId: ctx.conversationId, authorType: 'system', text: { startsWith: 'Paused ' } },
    }), 20_000)
    await quiet()
    expect(paused.text).toContain('back and forth')
    expect(invocations.length).toBe(MAX_AGENT_PING_PONG_TURNS)
    expect(runsOf(null).at(-1)!.prompt).toMatch(/the last \d+ alternating between you and Samsara Backend Engineer/)
  })
})
