// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-277 A1 — many agents streaming on one computer.
 *
 * Russell's report: "when there are many agents running on a computer the
 * computer starts to be slow to load chats and the app navigation slows down".
 * This test reproduces it against the **real local API**: a real bun:sqlite
 * database (the same migrations the desktop ships, via
 * `setupChannelsTestDb`), the real route table (`createLocalApp`), and the real
 * relay persistence path (`trackUsageFromStream`) consuming a runtime SSE
 * stream frame for frame.
 *
 * While N turns stream, it probes the routes a person actually waits on when
 * they open a chat or navigate, and records the event loop's delay histogram.
 * A synchronous SQLite driver (`prisma-adapter-bun-sqlite`) means any work the
 * relay does on the event loop directly becomes the user's latency, which is
 * the mechanism this test exists to catch.
 *
 * Run it with `bun run test:load:local` (see `docs/perf/local-api.md`).
 * Opt-in only: too slow for the required `Lint, Typecheck, Test` lane.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import { setupChannelsTestDb } from '../helpers/channels-test-db'
import { makeAgentTurnFrames, makeTimedSseStream } from '../helpers/fake-runtime-stream'

// ─── Environment before anything imports lib/prisma ──────────────────────
const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-load-ws-'))
process.env.WORKSPACES_DIR = workspacesDir
process.env.SHOGO_LOCAL_MODE = 'true'
// The probe loop issues far more requests than a person navigates; the route
// limiter would answer 429 and the test would measure errors instead of
// latency. This is a latency test, not a rate-limit test.
process.env.RATE_LIMIT_GLOBAL_MAX = '10000000'

const { prisma } = await import('../../lib/prisma')
const { createLocalApp } = await import('../../app/create-local-app')
const { trackUsageFromStream } = await import('../../routes/project-chat')

const db = prisma as any
const app = createLocalApp().app

// ─── Snapshot-write accounting ───────────────────────────────────────────
// The cost this test is about is the relay rewriting the whole growing
// assistant message once per tool result. Counting the `chatMessage.update`
// calls and their payload size measures that directly, whatever the driver
// does with them.
const snapshotWrites: Array<{ bytes: number; at: number }> = []
const realUpdate = db.chatMessage.update.bind(db.chatMessage)
db.chatMessage.update = async (args: any) => {
  const payload = args?.data?.parts ?? args?.data?.content ?? ''
  snapshotWrites.push({ bytes: typeof payload === 'string' ? payload.length : JSON.stringify(payload).length, at: Date.now() })
  return realUpdate(args)
}

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const RESULTS_DIR = join(REPO_ROOT, 'test-results', 'local-load')

// ─── Scale knobs (bigger = closer to Russell's machine, slower to run) ───
const TOOL_COUNT = Number(process.env.SHOGO_LOAD_TOOL_COUNT || 110)
const TURN_MS = Number(process.env.SHOGO_LOAD_TURN_MS || 4_000)
/** Deliver the whole script in TURN_MS, whatever its frame count. */
const FRAME_INTERVAL_MS = Math.max(1, Math.round(TURN_MS / (TOOL_COUNT * 2)))
const PROJECT_COUNT = Number(process.env.SHOGO_LOAD_PROJECTS || 30)
const SESSION_COUNT = Number(process.env.SHOGO_LOAD_SESSIONS || 200)
const HEAVY_SESSIONS = Number(process.env.SHOGO_LOAD_HEAVY_SESSIONS || 3)
const HEAVY_MESSAGE_BYTES = Number(process.env.SHOGO_LOAD_HEAVY_MESSAGE_BYTES || 350 * 1024)
const LEVELS = (process.env.SHOGO_LOAD_LEVELS || '0,4,8,16').split(',').map((n) => Number(n.trim()))

// ─── Budgets (the test fails above them) ────────────────────────────────
const BUDGET = {
  /** At N=16 the event loop must not stutter longer than this (p99). */
  eventLoopP99Ms: 50,
  /** Opening a chat: GET the first page of its messages. */
  messagesP95Ms: 300,
  /** Every navigation/poll list route. */
  listP95Ms: 150,
  /** No route may degrade past this factor of its own N=0 p95. */
  degradationFactor: 2.5,
}

interface Sample {
  route: string
  ms: number
}

interface LevelResult {
  n: number
  turnMs: number
  /** Snapshot writes per turn (see `snapshotWrites` accounting above). */
  snapshotWrites: number
  snapshotWriteBudget: number
  snapshotBytesPerTurn: number
  eventLoop: { p50: number; p99: number; max: number }
  routes: Record<string, { count: number; p50: number; p95: number; p99: number; max: number; status: number }>
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function summarise(samples: Sample[]): LevelResult['routes'] {
  const byRoute = new Map<string, { values: number[]; status: number }>()
  for (const sample of samples) {
    const entry = byRoute.get(sample.route) ?? { values: [], status: 0 }
    entry.values.push(sample.ms)
    byRoute.set(sample.route, entry)
  }
  const out: LevelResult['routes'] = {}
  for (const [route, entry] of byRoute) {
    const sorted = [...entry.values].sort((a, b) => a - b)
    out[route] = {
      count: sorted.length,
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      p99: Number(percentile(sorted, 99).toFixed(1)),
      max: Number(sorted[sorted.length - 1].toFixed(1)),
      status: entry.status,
    }
  }
  return out
}

// ─── Seeding: a local DB shaped like a machine that has run many agents ───
const suffix = crypto.randomUUID().slice(0, 8)
let userId: string
let workspaceId: string
let heavySessionId: string
let projectIds: string[] = []
const turnSessionIds: string[] = []

function bigParts(generation: number): string {
  // What a real assistant turn with ~110 tool calls looks like once persisted:
  // 110 `dynamic-tool` parts, sized so the whole message is about
  // HEAVY_MESSAGE_BYTES (Russell's measured average for a >200 KB turn).
  const parts: any[] = []
  const perPart = Math.max(1024, Math.round(HEAVY_MESSAGE_BYTES / 110))
  for (let i = 0; i < 110; i++) {
    parts.push({
      type: 'dynamic-tool',
      toolCallId: `seed-${generation}-${i}`,
      toolName: i % 3 === 0 ? 'read_file' : i % 3 === 1 ? 'grep' : 'exec',
      state: 'output-available',
      input: { path: `src/module-${i}.ts` },
      output: { success: true, text: `gen${generation}-${i} `.repeat(Math.ceil(perPart / 8)).slice(0, perPart) },
    })
    if (i % 12 === 11) parts.push({ type: 'text', text: `Step ${i}: read module-${i}.ts and moved on.` })
  }
  return JSON.stringify(parts)
}

async function seed(): Promise<void> {
  const user = await db.user.create({ data: { name: 'load', email: `load-${suffix}@example.com` } })
  userId = user.id
  const workspace = await db.workspace.create({
    data: { name: 'Load Workspace', slug: `load-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { userId, workspaceId, role: 'owner', isBillingAdmin: true } })

  for (let i = 0; i < PROJECT_COUNT; i++) {
    const project = await db.project.create({
      data: { name: `Load Project ${i}`, workspaceId },
    })
    projectIds.push(project.id)
  }

  // Sessions spread over the projects, like a workspace that has been used.
  const sessionRows: any[] = []
  for (let i = 0; i < SESSION_COUNT; i++) {
    sessionRows.push({
      id: `load-sess-${suffix}-${i}`,
      inferredName: `Chat ${i}`,
      name: `Chat ${i}`,
      contextType: 'project',
      contextId: projectIds[i % projectIds.length],
      cachedMessageCount: 4,
      lastActiveAt: new Date(Date.now() - i * 60_000),
    })
  }
  await db.chatSession.createMany({ data: sessionRows })

  // Every session gets a short transcript; the first few get the big ones.
  let generation = 0
  for (const session of sessionRows) {
    const messages: any[] = []
    for (let m = 0; m < 4; m++) {
      messages.push({
        sessionId: session.id,
        role: m % 2 === 0 ? 'user' : 'assistant',
        content: m % 2 === 0 ? `Question ${m} for ${session.name}` : `Answer ${m} for ${session.name}`,
      })
    }
    await db.chatMessage.createMany({ data: messages })
  }

  // Sessions whose transcript is the thing that makes opening a chat slow.
  const heavyIds: string[] = []
  for (let h = 0; h < HEAVY_SESSIONS; h++) {
    const sessionId = `load-heavy-${suffix}-${h}`
    heavyIds.push(sessionId)
    if (h === 0) heavySessionId = sessionId
    await db.chatSession.create({
      data: {
        id: sessionId,
        inferredName: `Heavy Chat ${h}`,
        name: `Heavy Chat ${h}`,
        contextType: 'project',
        contextId: projectIds[h % projectIds.length],
        cachedMessageCount: 50,
        lastActiveAt: new Date(),
      },
    })
    for (let m = 0; m < 50; m++) {
      await db.chatMessage.create({
        data: {
          sessionId,
          role: m % 2 === 0 ? 'user' : 'assistant',
          content: `Turn ${m}`,
          ...(m % 2 === 1 ? { parts: bigParts(generation++) } : {}),
        },
      })
    }
  }

  // One 10 MB inline base64 file part, the shape a screenshot upload leaves.
  await db.chatMessage.create({
    data: {
      sessionId: heavyIds[0],
      role: 'user',
      content: 'here is the screenshot',
      parts: JSON.stringify([
        { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: `data:image/png;base64,${'A'.repeat(10 * 1024 * 1024)}` },
      ]),
    },
  })

  // Sessions the streaming turns write into (one per concurrent agent).
  const maxN = Math.max(...LEVELS)
  for (let i = 0; i < maxN; i++) {
    const sessionId = `load-turn-${suffix}-${i}`
    turnSessionIds.push(sessionId)
    await db.chatSession.create({
      data: {
        id: sessionId,
        inferredName: `Turn Chat ${i}`,
        name: `Turn Chat ${i}`,
        contextType: 'project',
        contextId: projectIds[i % projectIds.length],
        activeTurnId: null,
      },
    })
  }
}

// ─── The probes: the requests a person waits on ──────────────────────────
function probeRoutes(): Array<{ route: string; path: string }> {
  return [
    { route: 'GET messages', path: `/api/chat-messages?sessionId=${heavySessionId}&agent=technical&limit=50&offset=0` },
    { route: 'GET chat-sessions', path: `/api/chat-sessions?contextId=${projectIds[0]}&limit=100` },
    { route: 'GET projects', path: `/api/projects?workspaceId=${workspaceId}&limit=50` },
    { route: 'GET active-chats', path: `/api/workspaces/${workspaceId}/active-chats` },
    // `useAgentActivity` polls this every 5 s, separately per mounted hook.
    { route: 'GET agent-tasks', path: `/api/agent-tasks?workspaceId=${workspaceId}` },
    // The refocus probe: one row wide, and it fires on every tab switch.
    { route: 'GET message tail', path: `/api/chat-messages?sessionId=${heavySessionId}&agent=technical&limit=1&orderBy=createdAt:desc` },
  ]
}

function as(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { 'x-tunnel-auth-user-id': userId, ...(init.headers ?? {}) },
  }
}

async function timeRoute(route: string, path: string): Promise<Sample & { status: number }> {
  const startedAt = performance.now()
  let status = 0
  try {
    const res = await app.request(path, as())
    status = res.status
    // Drain the body: the cost we care about is producing it, not just the head.
    await res.arrayBuffer()
  } catch {
    status = -1
  }
  return { route, ms: performance.now() - startedAt, status }
}

/** Start one turn on its own chat session and resolve when it finishes. */
function startTurn(sessionId: string, index: number): Promise<void> {
  const script = makeAgentTurnFrames({
    toolCount: TOOL_COUNT,
    turnId: `turn-${suffix}-${index}`,
    outputBytesRange: [2 * 1024, 20 * 1024],
  })
  const stream = makeTimedSseStream(script.frames, FRAME_INTERVAL_MS)
  return trackUsageFromStream(
    stream,
    { chatSessionId: sessionId, agentMode: 'advanced' },
    { id: projectIds[index % projectIds.length], workspaceId },
    { chatSessionId: sessionId, suppressCompletionPush: true },
  ).then(() => undefined)
}

async function runLevel(n: number): Promise<LevelResult> {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  const samples: Sample[] = []
  let statuses: number[] = []

  histogram.enable()
  const startedAt = Date.now()

  const turns = Array.from({ length: n }, (_, i) => startTurn(turnSessionIds[i], i))

  // Probe while the turns stream, one round at a time, until they are done.
  const routes = probeRoutes()
  let done = false
  let failure: unknown = null
  const finished = Promise.all(turns).then(
    () => { done = true },
    (err) => { failure = err; done = true },
  )
  // Always complete a full round, even at N=0 where the turns are already
  // over: the quiet-state baseline has to cover every route.
  do {
    for (const { route, path } of routes) {
      const sample = await timeRoute(route, path)
      if (sample.status !== 200) statuses.push(`${route} → ${sample.status}`)
      samples.push({ route, ms: sample.ms })
    }
    // Yield to the timer phase. A round of in-process requests resolves on
    // microtasks alone, and a loop of those starves the streaming turns' own
    // timers — the measurement would then be of a stalled stream. 20 ms
    // between rounds is also a realistic probe rate.
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (!done)
  await finished
  if (failure) throw failure

  histogram.disable()
  const turnMs = Date.now() - startedAt
  const writes = snapshotWrites.splice(0, snapshotWrites.length)
  const writesPerTurn = n > 0 ? writes.length / n : 0
  const bytesPerTurn = n > 0 ? writes.reduce((sum, w) => sum + w.bytes, 0) / n : 0

  const result: LevelResult = {
    n,
    turnMs,
    eventLoop: {
      p50: Number((histogram.percentile(50) / 1e6).toFixed(1)),
      p99: Number((histogram.percentile(99) / 1e6).toFixed(1)),
      max: Number((histogram.max / 1e6).toFixed(1)),
    },
    routes: summarise(samples),
    snapshotWrites: Math.round(writesPerTurn),
    /**
     * Coalesced writes are at most one per second of streaming plus the final
     * one. A 110-tool turn on main performs 110.
     */
    // Turns stream concurrently, so the level's wall time is one turn's
    // stream time: one write per second of stream, plus the final write.
    snapshotWriteBudget: n > 0 ? Math.ceil(turnMs / 1000) + 2 : 0,
    snapshotBytesPerTurn: Math.round(bytesPerTurn),
  }

  // A probe that 500s measures nothing: fail loudly instead of reporting a
  // fast error.
  if (statuses.length > 0) {
    throw new Error(`Probe route(s) returned ${[...new Set(statuses)].join(', ')} at N=${n} — the load test measured errors, not latency.`)
  }

  return result
}

// ─── The test ────────────────────────────────────────────────────────────
/**
 * Opt-in (`SHOGO_LOAD_TESTS=1`, which `bun run test:load:local` sets).
 *
 * The budgets below are wall-clock budgets for the machine Russell reported
 * from — 18 cores, sitting at load average 7–10. On a 2-vCPU CI runner the
 * *identical* code measures 180–285 ms of event-loop p99 at N=8–16 simply
 * because sixteen concurrent turns saturate two cores; the numbers measure the
 * runner, not the relay, so gating CI on them would be a false alarm either
 * way (fail on a green branch, pass on a bad one). The deterministic half of
 * this card — writes per turn and bytes per turn — runs everywhere in
 * `snapshot-write-budget.test.ts`.
 */
describe.skipIf(process.env.SHOGO_LOAD_TESTS !== '1')('many agents streaming on one computer', () => {
  let results: LevelResult[] = []

  afterAll(async () => {
    await db.$disconnect?.()
    rmSync(workspacesDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test(
    `N = ${LEVELS.join(', ')} stays inside the budgets`,
    async () => {
      await seed()

      for (const n of LEVELS) {
        results.push(await runLevel(n))
      }

      // Print the table the PR pastes.
      const header = ['N', 'event p99', 'turn ms', ...Object.keys(results[0].routes).map((r) => `${r} p95`)]
      const rows = results.map((level) => [
        String(level.n),
        String(level.eventLoop.p99),
        String(level.turnMs),
        ...Object.keys(level.routes).map((r) => String(level.routes[r]?.p95 ?? '-')),
      ])
      console.log('\n[SHO-277] local load, many agents streaming')
      console.log(header.join(' | '))
      for (const row of rows) console.log(row.join(' | '))
      for (const level of results) {
        console.log(`  N=${level.n} event loop p50=${level.eventLoop.p50}ms p99=${level.eventLoop.p99}ms max=${level.eventLoop.max}ms`)
        console.log(`  N=${level.n} snapshot writes/turn=${level.snapshotWrites} budget=${level.snapshotWriteBudget} bytes/turn=${level.snapshotBytesPerTurn}`)
      }

      mkdirSync(RESULTS_DIR, { recursive: true })
      writeFileSync(
        join(RESULTS_DIR, 'many-agents.json'),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            config: { toolCount: TOOL_COUNT, turnMs: TURN_MS, projects: PROJECT_COUNT, sessions: SESSION_COUNT, heavySessions: HEAVY_SESSIONS },
            budget: BUDGET,
            levels: results,
          },
          null,
          2,
        ) + '\n',
      )

      const worst = results[results.length - 1]
      const base = results[0]

      expect(worst.eventLoop.p99).toBeLessThanOrEqual(BUDGET.eventLoopP99Ms)
      expect({ writes: worst.snapshotWrites, budget: worst.snapshotWriteBudget }).toMatchObject({
        writes: expect.any(Number),
        budget: expect.any(Number),
      })
      expect(worst.snapshotWrites).toBeLessThanOrEqual(worst.snapshotWriteBudget)
      expect(worst.routes['GET messages'].p95).toBeLessThanOrEqual(BUDGET.messagesP95Ms)
      for (const [route, stats] of Object.entries(worst.routes)) {
        expect({ route, p95: stats.p95 }).toMatchObject({ route, p95: expect.any(Number) })
        expect(stats.p95).toBeLessThanOrEqual(route === 'GET messages' ? BUDGET.messagesP95Ms : BUDGET.listP95Ms)
      }

      // No route may degrade past 2.5x its own quiet-state p95. A route with
      // almost no idle time (a few ms) would make the ratio meaningless, so a
      // 25 ms floor applies to the baseline.
      for (const [route, stats] of Object.entries(worst.routes)) {
        const quiet = Math.max(base.routes[route]?.p95 ?? 0, 25)
        expect({ route, ratio: Number((stats.p95 / quiet).toFixed(2)) }).toMatchObject({
          route,
          ratio: expect.any(Number),
        })
        expect(stats.p95 / quiet).toBeLessThanOrEqual(BUDGET.degradationFactor)
      }
    },
    { timeout: 240_000 },
  )
})
