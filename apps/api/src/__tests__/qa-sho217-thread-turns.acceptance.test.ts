// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-217: "the 101st agent turn in a thread pauses with
 * 'Paused after 100 agent turns in this thread', and every pause is countable
 * (which limit, how often)."
 *
 * The dev's `conversation-agent-chains.integration.test.ts` proves the pause
 * note, the `blocks.chainPaused` payload and the single metric record for the
 * *depth* and *ping_pong* limits, and `agent-chain-metrics.test.ts` proves the
 * counter itself emits with the `limit` label. Neither drives the third limit
 * through the real dispatcher, so this file does: the thread-turn ceiling is
 * lowered to 3, three agent replies are allowed to run, and the 4th is refused
 * — with the real `recordChainPaused` in the graph (an in-memory OTel provider,
 * no mock), so the counter the card promises in SigNoz is what gets asserted.
 *
 * The default of 100 is covered by `conversation-agent-chain.test.ts`
 * (`MAX_AGENT_TURNS_PER_THREAD`, the 100/101 boundary); 101 real turns is not
 * something to run in a test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { metrics } from '@opentelemetry/api'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

// Read once at module load by `conversation-agent-chain.ts`, so it has to be
// set before the dispatcher (which imports it) is loaded below.
process.env.SHOGO_AGENT_CHAIN_MAX_THREAD_TURNS = '3'

// The counter is created when `agent-chain-metrics` loads, so the provider has
// to be registered first — the ordering apps/api/src/entry.ts guarantees in
// production by importing instrumentation before the server.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
})
metrics.setGlobalMeterProvider(provider)

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const chain = await import('../services/conversation-agent-chain')

const db = prisma as any
let seed: SeededWorkspace
let analyst: string
let planner: string

interface Invocation { projectId: string | null; userId: string; prompt: string }
let invocations: Invocation[] = []
let scripts: Record<string, () => string> = {}

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const tag = (projectId: string) => `<@a:p:${projectId}>`

/** The `agent_chain.paused` data points the real counter emitted. */
async function pausedPoints(): Promise<Array<{ value: number; attributes: Record<string, unknown> }>> {
  await provider.forceFlush()
  return exporter.getMetrics()
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .filter((m) => m.descriptor.name === 'agent_chain.paused')
    .flatMap((m) => m.dataPoints as unknown as Array<{ value: number; attributes: Record<string, unknown> }>)
}

/** The `[ChannelAgent] chain paused` log lines the real helper wrote. */
function pausedLogs(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((c) => c[0] === '[ChannelAgent] chain paused')
    .map((c) => c[1] as Record<string, unknown>)
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const mk = (name: string, description: string) =>
    db.project.create({ data: { name, description, workspaceId: seed.workspaceId } }).then((p: any) => p.id)
  analyst = await mk('Issue Pipeline — Analyst', 'Finds root causes and proposes options')
  planner = await mk('Planner', 'Writes implementation plans')
})

beforeEach(async () => {
  invocations = []
  scripts = {}
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      const inv = { projectId: args.projectId, userId: args.userId, prompt: args.prompt }
      invocations.push(inv)
      const text = scripts[args.projectId ?? 'ws']?.() ?? 'ok'
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterEach(async () => {
  dispatcher._resetDispatcherForTests()
})

afterAll(async () => {
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } }).catch(() => {})
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function channel(name: string) {
  const res = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name })
  return res.json.conversation.id as string
}

const post = async (user: string, conversationId: string, text: string, threadRootId?: string) =>
  (await call(user, 'POST', `/conversations/${conversationId}/messages`, { text, threadRootId })).json.message.id as string

async function settle(ms = 150) {
  await new Promise((r) => setTimeout(r, ms))
  await waitFor(async () => !(await db.conversationMessage.findFirst({ where: { agentStatus: 'running' } })))
}

describe('the thread-turn ceiling', () => {
  test('the configured limit is what the chain module exposes', () => {
    expect(chain.MAX_AGENT_TURNS_PER_THREAD).toBe(3)
    expect(chain.chainLimitMax('thread_turns')).toBe(3)
  })

  test('the turn after the ceiling pauses the chain, names the limit, and is counted once', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {})
    try {
      const id = await channel('thread-turns')
      scripts[analyst] = () => `${tag(planner)} next`
      scripts[planner] = () => `${tag(analyst)} next`
      const root = await post(seed.member, id, `${tag(analyst)} start`)

      const paused = await waitFor(
        async () => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'system' } }),
        5000,
      )
      await settle()

      // Three turns ran (the ceiling), the 4th was refused.
      expect(invocations.map((i) => i.projectId)).toEqual([analyst, planner, analyst])
      expect(await db.conversationMessage.count({ where: { threadRootId: root, authorType: 'system' } })).toBe(1)

      // The note a person sees names the limit, in the card's words, and tags them.
      expect(paused.text).toBe(`Paused after 3 agent turns in this thread. <@u:${seed.member}>, reply here to continue.`)

      // The persisted block answers the same question from the DB on any surface.
      expect(paused.blocks).toEqual({ chainPaused: { limit: 'thread_turns', depth: 3, turns: 3, max: 3 } })

      // Counted once, labelled by which limit, with the ids kept in the log line.
      const points = await pausedPoints()
      expect(points).toHaveLength(1)
      expect(points[0].attributes).toEqual({ limit: 'thread_turns' })
      expect(points[0].value).toBe(1)

      const rootRow = await db.conversationMessage.findUnique({ where: { id: root } })
      expect(pausedLogs(info)).toEqual([{
        limit: 'thread_turns',
        turns: 3,
        depth: 3,
        max: 3,
        workspaceId: seed.workspaceId,
        conversationId: rootRow.conversationId,
        threadRootId: root,
      }])
    } finally {
      info.mockRestore()
    }
  }, 30_000)

  test('a person replying resets the count, so the chain runs again', async () => {
    const id = await channel('thread-turns-resume')
    scripts[analyst] = () => `${tag(planner)} next`
    scripts[planner] = () => `${tag(analyst)} next`
    const root = await post(seed.member, id, `${tag(analyst)} start`)
    await waitFor(async () => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'system' } }), 5000)
    await settle()
    expect(invocations).toHaveLength(3)

    scripts[analyst] = () => 'Stopping here.'
    await post(seed.member, id, `${tag(analyst)} wrap up`, root)
    const final = await waitFor(async () => db.conversationMessage.findFirst({
      where: { threadRootId: root, authorType: 'agent', text: 'Stopping here.', agentStatus: 'done' },
    }))
    expect(final).toBeTruthy()
    expect(invocations).toHaveLength(4)
    expect(invocations[3].userId).toBe(seed.member)
    await settle()
  }, 30_000)
})
