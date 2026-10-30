// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-178 — a heartbeat tick must start from an empty transcript and pick its
 * model on purpose.
 *
 * The production shape this reproduces: every tick ran in one shared
 * `heartbeat` session, so a single turn key stayed open for ten days, each
 * firing re-sent the whole history, and Auto — seeing a huge context — routed
 * the tick to its premium tier. These tests pin both halves: flat per-tick
 * input and a resolved, non-Auto model.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createAssistantMessageEventStream, type Message } from '@mariozechner/pi-ai'
import {
  heartbeatSessionIdFor,
  heartbeatSessionProjectId,
  isHeartbeatChatSessionId,
} from '@shogo/shared-runtime/heartbeat-session'
import { AgentGateway } from '../gateway'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { PLATFORM_DEFAULT_HEARTBEAT_MODEL, formatHeartbeatModelLog, resolveHeartbeatModel } from '../heartbeat-model'

const TEST_DIR = '/tmp/test-heartbeat-fresh-session'

/**
 * What the tick's `AgentConfig` lookup answers. Stubbed on the gateway instance
 * rather than with `mock.module('../internal-api')`: a module mock is global to
 * the test process and breaks QA's acceptance file, which drives the real
 * internal API through a stub server in the same run.
 */
let agentSnapshot: { modelName?: string | null; modelProvider?: string | null } | null = null
let projectConfigCalls: Array<string | undefined> = []

function stubAgentConfigLookup(gateway: AgentGateway) {
  ;(gateway as any).heartbeatAgentModelSnapshot = async (projectId?: string) => {
    projectConfigCalls.push(projectId)
    return agentSnapshot
  }
}


interface ModelCall {
  modelId: string
  messages: Message[]
}

function setupWorkspace(config: Record<string, unknown> = {}) {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })
  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: null, end: null, timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'auto' },
      ...config,
    }),
  )
  writeFileSync(
    join(TEST_DIR, 'AGENTS.md'),
    '# Identity\nTest Agent\n\n# Personality\nBe helpful.\n\n# User\nTest User\n\n# Operating Instructions\nYou are a test agent.',
  )
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\nTest memory.')
  writeFileSync(join(TEST_DIR, 'HEARTBEAT.md'), '- Check system status')
}

/** A stream fn that answers every call with HEARTBEAT_OK and records the request. */
function recordingStream(calls: ModelCall[]) {
  return (model: any, context: any) => {
    calls.push({ modelId: String(model?.id ?? model), messages: [...(context?.messages ?? [])] })
    const message = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'HEARTBEAT_OK' }],
      api: 'anthropic-messages' as const,
      provider: 'anthropic',
      model: String(model?.id ?? model),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    }
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'done', reason: 'stop', message })
      stream.end(message)
    })
    return stream
  }
}

function userTexts(messages: Message[]): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as any[]).filter((c) => c?.type === 'text').map((c) => c.text).join(''),
    )
}

describe('resolveHeartbeatModel', () => {
  test('a model configured for the project wins', () => {
    const choice = resolveHeartbeatModel({
      agentModelName: 'claude-sonnet-4-5',
      agentModelProvider: 'anthropic',
      runtimeModel: { name: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
      economyTier: { id: 'deepseek-flash', provider: 'custom' },
    })
    expect(choice).toEqual({ id: 'claude-sonnet-4-5', provider: 'anthropic', source: 'agent_config' })
  })

  test('a stored value that expresses no choice is skipped, not obeyed', () => {
    for (const modelName of ['', '  ', 'auto', 'claude-haiku-4-5', null, undefined]) {
      const choice = resolveHeartbeatModel({
        agentModelName: modelName,
        runtimeModel: { name: 'auto' },
        economyTier: { id: 'deepseek-flash', provider: 'custom' },
      })
      expect(choice.source).toBe('platform_default')
      expect(choice.id).toBe('deepseek-flash')
    }
  })

  test('falls back to the runtime config when the project has no model', () => {
    const choice = resolveHeartbeatModel({
      agentModelName: null,
      runtimeModel: { name: 'claude-sonnet-4-5', provider: 'anthropic' },
      economyTier: { id: 'deepseek-flash', provider: 'custom' },
    })
    expect(choice).toEqual({ id: 'claude-sonnet-4-5', provider: 'anthropic', source: 'runtime_config' })
  })

  test('nothing configured at all resolves to the platform default, never auto', () => {
    const choice = resolveHeartbeatModel({ runtimeModel: { name: 'auto' } })
    expect(choice).toEqual({ id: PLATFORM_DEFAULT_HEARTBEAT_MODEL, source: 'platform_default' })
    expect(choice.id).toBe('hoshi-2-0')
  })

  test('the log line names the model and the rung it came from', () => {
    const line = formatHeartbeatModelLog({ id: 'deepseek-flash', provider: 'custom', source: 'platform_default' })
    expect(line).toBe('Heartbeat model: deepseek-flash (source=platform_default) provider=custom')
  })
})

describe('heartbeatTick: fresh session per tick', () => {
  let gateway: AgentGateway
  let calls: ModelCall[]

  beforeEach(() => {
    setupWorkspace()
    agentSnapshot = null
    projectConfigCalls.length = 0
    calls = []
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  function start(config?: Record<string, unknown>) {
    if (config) setupWorkspace(config)
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(recordingStream(calls) as any)
    stubAgentConfigLookup(gateway)
    return gateway
  }

  test('every tick sees the checklist and nothing from earlier ticks (50 ticks, bounded context)', async () => {
    await start().start()

    const perTickMessageCounts: number[] = []
    const perTickPromptChars: number[] = []
    for (let tick = 0; tick < 50; tick++) {
      expect(await gateway.triggerHeartbeat()).toBe('HEARTBEAT_OK')
      const call = calls[calls.length - 1]!
      perTickMessageCounts.push(call.messages.length)
      perTickPromptChars.push(userTexts(call.messages).join('\n').length)
    }

    // 50 ticks, one API call each, each from an empty session: exactly one
    // message goes out. Before SHO-178 the count climbed by 2 per tick and the
    // prompt grew without bound — the 10-day production transcript.
    expect(calls).toHaveLength(50)
    expect(new Set(perTickMessageCounts)).toEqual(new Set([1]))
    expect(userTexts(calls[0]!.messages)[0]).toContain('Check system status')

    // The carried-over state (the HEARTBEAT_LOG.md tail) is capped, so the
    // prompt plateaus instead of growing with the tick count: tick 50 is no
    // bigger than tick 25, and both are far smaller than any real transcript.
    expect(perTickPromptChars[49]).toBeLessThanOrEqual(perTickPromptChars[24]!)
    expect(perTickPromptChars[49]).toBeLessThan(4000)
  })

  test('the tick bills under a heartbeat:<projectId>:<tickId> session that analytics recognises', async () => {
    const seenSessionIds = new Set<string>()
    await start().start()
    const manager = (gateway as any).sessionManager
    const original = manager.getOrCreate.bind(manager)
    manager.getOrCreate = (id: string) => {
      seenSessionIds.add(id)
      return original(id)
    }

    await gateway.triggerHeartbeat()
    const firstTick = [...seenSessionIds].filter((id) => id.startsWith('heartbeat:'))
    await gateway.triggerHeartbeat()

    const tickIds = [...seenSessionIds].filter((id) => id.startsWith('heartbeat:'))
    // A fresh session per tick — never the same id twice.
    expect(firstTick).toHaveLength(1)
    expect(tickIds).toHaveLength(2)
    for (const id of tickIds) {
      expect(isHeartbeatChatSessionId(id)).toBe(true)
      // The project segment is what analytics attributes the spend to (SHO-182),
      // and it is the same project on every tick of this runtime.
      expect(heartbeatSessionProjectId(id)).toBe(heartbeatSessionProjectId(tickIds[0]!))
      expect(heartbeatSessionProjectId(id)).toBeTruthy()
    }
  })

  test('the per-tick session is discarded, not left behind', async () => {
    await start().start()
    await gateway.triggerHeartbeat()

    const manager = (gateway as any).sessionManager
    expect(manager.getAllStats().filter((s: any) => s.id.startsWith('heartbeat'))).toHaveLength(0)
    expect(existsSync(join(TEST_DIR, '.shogo', 'sessions.db'))).toBe(true)
    const db = new Database(join(TEST_DIR, '.shogo', 'sessions.db'))
    const rows = db.prepare("SELECT id FROM sessions WHERE id LIKE 'heartbeat%'").all() as Array<{ id: string }>
    db.close()
    expect(rows).toEqual([])
  })

  test('two projects on one runtime never share heartbeat history', async () => {
    const dirA = join(TEST_DIR, 'proj-a')
    const dirB = join(TEST_DIR, 'proj-b')
    for (const [dir, task] of [
      [dirA, 'PROJECT-A task'],
      [dirB, 'PROJECT-B task'],
    ] as const) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'HEARTBEAT.md'), `- ${task}`)
    }
    await start().start()

    await gateway.triggerHeartbeat({ projectId: 'proj-a', projectDir: dirA })
    await gateway.triggerHeartbeat({ projectId: 'proj-b', projectDir: dirB })
    await gateway.triggerHeartbeat({ projectId: 'proj-a', projectDir: dirA })

    const prompts = calls.map((c) => userTexts(c.messages).join('\n'))
    expect(prompts[0]).toContain('PROJECT-A task')
    expect(prompts[1]).toContain('PROJECT-B task')
    expect(prompts[1]).not.toContain('PROJECT-A task')
    // The second tick for A carries none of B's work either.
    expect(prompts[2]).toContain('PROJECT-A task')
    expect(prompts[2]).not.toContain('PROJECT-B task')
    for (const call of calls) expect(call.messages).toHaveLength(1)
  })

  test('the tick is told what the previous ticks concluded, so nothing is re-done blind', async () => {
    await start().start()
    writeFileSync(
      join(TEST_DIR, 'HEARTBEAT_LOG.md'),
      '# Recent Heartbeat Activity\n\n- [2026-10-28T09:00:00.000Z] Routine check — all clear\n',
    )

    await gateway.triggerHeartbeat()

    const prompt = userTexts(calls[0]!.messages).join('\n')
    expect(prompt).toContain('## Recent heartbeat results')
    expect(prompt).toContain('Routine check — all clear')
  })

  test('pending events still reach the tick now that no transcript carries them', async () => {
    await start().start()
    gateway.queuePendingEvent('New email from boss')

    await gateway.triggerHeartbeat()

    const prompt = userTexts(calls[0]!.messages).join('\n')
    expect(prompt).toContain('## Pending Events')
    expect(prompt).toContain('New email from boss')
  })
})

describe('heartbeatTick: the model is picked on purpose', () => {
  let gateway: AgentGateway
  let calls: ModelCall[]

  beforeEach(() => {
    setupWorkspace()
    agentSnapshot = null
    projectConfigCalls.length = 0
    calls = []
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  function start(config?: Record<string, unknown>) {
    if (config) setupWorkspace(config)
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(recordingStream(calls) as any)
    stubAgentConfigLookup(gateway)
    return gateway
  }

  test('a project configured for Sonnet gets Sonnet, even though the runtime config says auto', async () => {
    agentSnapshot = { modelName: 'claude-sonnet-4-5', modelProvider: 'anthropic' }
    await start().start()

    await gateway.triggerHeartbeat()

    // The tick asked the API for the project's own model, and used it.
    expect(projectConfigCalls.length).toBeGreaterThan(0)
    expect(calls[0]!.modelId).toContain('claude-sonnet-4-5')
  })

  test('with no model configured the tick runs the platform default — never the premium auto tier', async () => {
    // `auto` is what escalated a big-context tick to premium in production.
    await start({ model: { provider: 'anthropic', name: 'auto' } }).start()
    // No admin tier map in this environment: the platform constant is the default.
    ;(gateway as any).autoTierOverride = undefined

    await gateway.triggerHeartbeat()

    expect(calls[0]!.modelId).not.toBe('auto')
    expect(calls[0]!.modelId).toBe(PLATFORM_DEFAULT_HEARTBEAT_MODEL)
  })

  test('the admin economy tier is the platform default when the runtime has one', async () => {
    await start().start()
    ;(gateway as any).autoTierOverride = { economy: { id: 'deepseek-flash', provider: 'custom' } }

    await gateway.triggerHeartbeat()

    expect(calls[0]!.modelId).toBe('deepseek-flash')
  })

  test('every tick logs the resolved model and its source', async () => {
    agentSnapshot = { modelName: 'claude-sonnet-4-5', modelProvider: 'anthropic' }
    await start().start()
    const logs: string[] = []
    gateway.setLogCallback((line) => logs.push(line))

    await gateway.triggerHeartbeat()

    const modelLine = logs.find((line) => line.includes('Heartbeat model:'))
    expect(modelLine).toBeDefined()
    expect(modelLine).toContain('claude-sonnet-4-5')
    expect(modelLine).toContain('source=agent_config')
  })

  test('the heartbeat log still records the tick outcome', async () => {
    await start().start()

    await gateway.triggerHeartbeat()

    const log = readFileSync(join(TEST_DIR, 'HEARTBEAT_LOG.md'), 'utf-8')
    expect(log).toContain('Routine check — all clear')
  })
})

describe('heartbeatTick: what a tick leaves running', () => {
  let gateway: AgentGateway

  beforeEach(() => {
    setupWorkspace()
    agentSnapshot = null
    projectConfigCalls.length = 0
    trustWorkspaceForTests(TEST_DIR)
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    clearTrustForTests()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('finished background work is carried to the next tick, not an API wake nobody reads', async () => {
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(recordingStream([]) as any)
    await gateway.start()

    const gw = gateway as any
    const sessionId = heartbeatSessionIdFor('proj-x', 'tick-1')
    const note = {
      taskId: 'task-1',
      source: 'exec' as const,
      title: 'scan the inbox',
      status: 'completed' as const,
      exitCode: 0,
      tail: 'done',
      finishedAt: Date.now(),
    }
    const reported: string[] = []
    gw.commandRegistries.set(sessionId, {
      peekNotifications: () => [note],
      get: () => ({ reported: false }),
      markReported: (ids: string[]) => reported.push(...ids),
    })

    await gw.flushTaskWake(sessionId)

    // Reported once — the API would queue a wake for a chat session that never
    // runs again and drop it.
    expect(reported).toEqual(['task-1'])
    const pending = gw.pendingEvents as Array<{ projectId: string | null; text: string }>
    expect(pending).toHaveLength(1)
    // Scoped to the project the tick ran for, so another project's tick never sees it.
    expect(pending[0]!.projectId).toBe('proj-x')
    expect(pending[0]!.text).toContain('scan the inbox')
  })

  test('a registry kept alive for running work is wiped once it drains', async () => {
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(recordingStream([]) as any)
    await gateway.start()

    const gw = gateway as any
    const sessionId = heartbeatSessionIdFor('proj-x', 'tick-2')
    let running = 1
    const listeners: Array<() => void> = []
    const kills: string[] = []
    gw.commandRegistries.set(sessionId, {
      listRunning: () => new Array(running).fill({ id: 'x' }),
      peekNotifications: () => [],
      get: () => undefined,
      onChange: (cb: () => void) => {
        listeners.push(cb)
        return () => listeners.splice(listeners.indexOf(cb), 1)
      },
      killAll: (opts: { clear?: boolean }) => {
        kills.push(opts.clear ? 'clear' : 'kill')
        return []
      },
    })

    gw.disposeSessionState(sessionId, { keepRunningWork: true })

    // Work is still going: the registry and its log stay so the task can report.
    expect(gw.commandRegistries.has(sessionId)).toBe(true)
    expect(kills).toEqual([])

    running = 0
    for (const listener of listeners) listener()
    await Bun.sleep(20)

    expect(gw.commandRegistries.has(sessionId)).toBe(false)
    expect(kills).toEqual(['clear'])
  })

  test('a tick that leaves nothing running is wiped immediately', async () => {
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(recordingStream([]) as any)
    await gateway.start()

    await gateway.triggerHeartbeat()

    const registries = (gateway as any).commandRegistries as Map<string, any>
    expect([...registries.keys()].filter((id) => id.startsWith('heartbeat:'))).toEqual([])
    expect((gateway as any).pendingEvents).toEqual([])
  })
})

describe('heartbeat session ids', () => {
  test('a runtime that resolves no project gets a fresh tick id, not a fake project', () => {
    // Analytics reads the project segment and falls back to the usage row's own
    // projectId when it is absent (SHO-182). A placeholder like `runtime` would
    // be read as a real project id and overwrite the row's — so the segment is
    // empty and `heartbeatSessionProjectId` answers null.
    const id = heartbeatSessionIdFor('', 'abc-1')
    expect(id).toBe('heartbeat::abc-1')
    expect(isHeartbeatChatSessionId(id)).toBe(true)
    expect(heartbeatSessionProjectId(id)).toBeNull()
  })

  test('a resolved project is named in the id', () => {
    const id = heartbeatSessionIdFor('3fb99014', 'abc-1')
    expect(heartbeatSessionProjectId(id)).toBe('3fb99014')
  })
})
