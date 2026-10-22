// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-123 acceptance — QA. A finished result belongs to the agent that started
 * it until that agent reads it, and a `wait` that arrives late recovers it from
 * the log instead of claiming the task never existed.
 *
 * The registry the gateway builds is composed here the way `gateway.ts` builds
 * it (same `outputDir`, `resolveOutputRow` over that dir), and every turn gets a
 * fresh `ToolContext` exactly as a real turn does — so "the counter resets next
 * turn" and "the result survives across turns" are measured, not asserted from
 * the registry's own unit tests.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createTools, type ToolContext } from '../gateway-tools'
import { TaskRegistry } from '../task-registry'
import { taskOutputDir, listTaskOutputRows } from '../task-output'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/qa-sho123-tasks'
const SRC_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, budgetMs = 4_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

function makeCtx(registry: TaskRegistry, frames: any[] = []): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'qa-sho123',
    commandRegistry: registry,
    uiWriter: { write: (f: any) => frames.push(f) } as any,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any> = {}) {
  const tool = createTools(ctx).find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return (await tool.execute('call-1', params)).details as any
}

/** The registry `AgentGateway.getOrCreateCommandRegistry` builds, with the windows shortened. */
function gatewayLikeRegistry(retentionMs = 25, unreadRetentionMs = 60_000) {
  const outputDir = taskOutputDir(TEST_DIR, 'chat-1')
  return new TaskRegistry({
    outputDir,
    workspaceDir: TEST_DIR,
    retentionMs,
    unreadRetentionMs,
    resolveOutputRow: (id) => listTaskOutputRows(outputDir).find((row) => row.taskId === id) ?? null,
  })
}

let registry: TaskRegistry

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
  registry = gatewayLikeRegistry()
})

afterEach(() => {
  registry.killAll()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

afterAll(() => clearTrustForTests())

describe('AC1/AC3: an unread result outlives the dock window, then comes back from its log', () => {
  test('a task that finished while nobody waited is still returned in the next turn, and recoverable after it', async () => {
    const turn1 = makeCtx(registry)
    const started = await run(turn1, 'exec', { command: 'sleep 0.05; touch finished.marker', background: true })
    expect(started.status).toBe('running')
    expect(await until(() => registry.get(started.task_id)?.status === 'completed')).toBe(true)

    // Well past the short window, and nobody waited: the result is still ours.
    await sleep(150)
    expect(registry.get(started.task_id)).toBeDefined()

    const turn2 = makeCtx(registry)
    const late = await run(turn2, 'wait', { task_ids: [started.task_id], timeout_ms: 0 })
    expect(late.status).toBe('completed')
    expect(late.task_id).toBe(started.task_id)
    expect(late.output_file).toBe(started.output_file)
    // Still in memory at that point, so this is the real entry — not a rebuild.
    expect(late.recovered).toBeUndefined()

    // The wait consumed it, so the short window now applies and it is evicted.
    await sleep(150)
    expect(registry.get(started.task_id)).toBeUndefined()

    const turn3 = makeCtx(registry)
    const recovered = await run(turn3, 'wait', { task_ids: [started.task_id], timeout_ms: 0 })
    expect(recovered.status).toBe('completed')
    expect(recovered.recovered).toBe(true)
    expect(recovered.output_file).toBe(started.output_file)
    expect(recovered.exit_code).toBe(0)
  })

  test('a consumed result the agent never finished reading is not the only survivor: the log is', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 0.05; echo QA-MARKER', background: true })
    expect(await until(() => registry.get(started.task_id)?.status === 'completed')).toBe(true)
    registry.markConsumed([started.task_id])
    await sleep(150)
    expect(registry.get(started.task_id)).toBeUndefined()

    const recovered = await run(makeCtx(registry), 'wait', { task_ids: [started.task_id], timeout_ms: 0 })
    expect(recovered.recovered).toBe(true)
    expect(String(recovered.output ?? '')).toContain('QA-MARKER')
  })

  test('only a missing log yields task_result_gone, and it names task_list and the file', async () => {
    const gone = await run(makeCtx(registry), 'wait', { task_ids: ['t_nolog123'] })
    expect(gone.code).toBe('task_result_gone')
    expect(String(gone.error)).toContain('task_list')
    expect(String(gone.error)).toContain('.shogo/tasks/chat-1/t_nolog123.log')
    expect(String(gone.error)).not.toContain('kept ~10 min')
    expect(String(gone.hint)).toContain('task_list')
  })
})

describe('AC4: unread rows stay listed, read ones follow the short window', () => {
  test('task_list shows the unread finished task until it is read and expires', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 0.05; touch listed.marker', background: true })
    expect(await until(() => registry.get(started.task_id)?.status === 'completed')).toBe(true)
    await sleep(100)

    const listed = await run(ctx, 'task_list')
    expect(listed.tasks.map((t: any) => t.task_id)).toContain(started.task_id)

    registry.markConsumed([started.task_id])
    await sleep(150)
    const after = await run(ctx, 'task_list')
    expect(after.tasks.map((t: any) => t.task_id)).not.toContain(started.task_id)
  })
})

describe('AC10: a repeated wait stops — and the next turn starts fresh', () => {
  test('the third wait returns at once, and a new turn waits again', async () => {
    const turn1 = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })

    expect((await run(turn1, 'wait', { task_ids: [task.entry.id], timeout_ms: 20 })).status).toBe('timeout')
    expect((await run(turn1, 'wait', { task_ids: [task.entry.id], timeout_ms: 20 })).status).toBe('timeout')

    const at = Date.now()
    const third = await run(turn1, 'wait', { task_ids: [task.entry.id], timeout_ms: 5_000 })
    expect(Date.now() - at).toBeLessThan(50)
    expect(third.code).toBe('stop_waiting')
    expect(String(third.hint)).toContain('[Task update]')

    // A new turn builds a new context, so the count that stopped it is gone.
    const turn2 = makeCtx(registry)
    const fourth = await run(turn2, 'wait', { task_ids: [task.entry.id], timeout_ms: 30 })
    expect(fourth.status).toBe('timeout')
    expect(fourth.code).toBeUndefined()

    task.finish('completed', { summary: 'ok' })
  })
})

describe('wiring: the recovery path is the one the gateway actually builds, and a busy chat queues', () => {
  test('gateway.ts resolves evicted results from the same output dir it hands the registry', () => {
    const src = readFileSync(join(SRC_DIR, 'gateway.ts'), 'utf8')
    expect(src).toContain('const outputDir = taskOutputDir(this.workspaceDir, sessionId)')
    expect(src).toMatch(/new TaskRegistry\(\{[\s\S]{0,400}?outputDir,[\s\S]{0,400}?resolveOutputRow:\s*\(id\)\s*=>\s*listTaskOutputRows\(outputDir\)/)
  })

  test('the runtime acks a wait:false pipeline call at once, naming the call it queued', () => {
    const src = readFileSync(join(SRC_DIR, 'server.ts'), 'utf8')
    const branch = src.slice(src.indexOf('if (body.wait === false) {'))

    // The ack never holds the response: the caller's forward timeout is 15 s.
    expect(branch).not.toContain('await turnStarted')
    expect(branch).toContain("status: started ? 'started' : 'queued'")
    // ...and it names the call, so the probe can answer for that call and not
    // for whatever turn the chat happens to be running.
    expect(branch).toContain('callId')
    expect(branch).toContain('onQueued')
    expect(branch).toContain('onTurnStarted')
    // A queued call is not an error any more, so no error body is built here.
    expect(branch.slice(0, branch.indexOf('try {'))).not.toContain("code: 'callee_turn_never_started'")

    const buffered = readFileSync(join(SRC_DIR, 'buffered-turn.ts'), 'utf8')
    // No start budget: a message for a busy chat waits, it is never dropped.
    expect(buffered).not.toContain('PIPELINE_START_TIMEOUT_MS')
    expect(buffered).toContain('onQueued?.()')
    // The queued call is registered under its name, and the turn it starts is
    // recorded against that name.
    expect(buffered).toContain('noteCallQueued')
    expect(buffered).toContain('noteCallStarted')
  })

  test('the turn probe answers for the named call, so a busy chat is not its turn', () => {
    const src = readFileSync(join(SRC_DIR, 'server.ts'), 'utf8')
    expect(src).toContain('liveTurnGate.callState(chatSessionId, callId)')
    expect(src).toContain("c.req.query('callId')")

    const status = readFileSync(join(SRC_DIR, 'turn-status.ts'), 'utf8')
    // `queued` is answered before the chat's snapshot is even considered, so a
    // busy chat's live turn cannot be offered as the queued call's turn.
    const callBranch = status.slice(status.indexOf('function describeCallTurn'))
    expect(callBranch.indexOf("status: 'queued'")).toBeLessThan(callBranch.indexOf('store.snapshot'))
    expect(callBranch).toContain("status: 'lost'")

    const api = readFileSync(join(SRC_DIR, '..', '..', '..', 'apps', 'api', 'src', 'services', 'agent-call.service.ts'), 'utf8')
    // The follower asks by name, treats `queued` as authoritative over any
    // timestamp, and follows only the turn the callee named as ours.
    expect(api).toContain('callId: call.runId')
    expect(api).toContain('?callId=')
    expect(api).toContain("probe.status === 'queued'")
    const readProbe = api.slice(api.indexOf('export function readCalleeTurn'))
    expect(readProbe.indexOf("probe.status === 'queued'")).toBeLessThan(readProbe.indexOf('TURN_CLOCK_SKEW_MS'))
    expect(api).toContain('deadline = Date.now() + deps.turnStartTimeoutMs')
    expect(api).toContain('expectedTurnId')
  })
})
