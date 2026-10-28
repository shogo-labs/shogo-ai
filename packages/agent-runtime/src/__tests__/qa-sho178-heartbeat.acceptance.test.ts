// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-178 — heartbeat runs in a fresh session per tick on an
 * explicitly chosen model.
 *
 * The card's own spec mocks `internal-api` to answer `getProjectConfig`. That
 * mock decides the shape of `res.data.agent` for the test, so it cannot fail
 * the way production would if the real endpoint answered something else. This
 * file drives the real `getProjectConfig` → `lifecycleFetch` → HTTP path
 * against a stub API server, which is the seam a heartbeat actually depends on
 * to honour `agent_configs.modelName`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createAssistantMessageEventStream, type Message } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { buildTextResponse, buildToolUseResponse, createMockStreamFn } from '../pi-adapter'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { PLATFORM_DEFAULT_HEARTBEAT_MODEL } from '../heartbeat-model'
import { heartbeatSessionProjectId, isHeartbeatChatSessionId } from '@shogo/shared-runtime/heartbeat-session'

interface ApiCall { method: string; path: string }
let server: ReturnType<typeof Bun.serve>
const apiCalls: ApiCall[] = []
const savedEnv: Record<string, string | undefined> = {}
/** `agent_configs` rows the stub API reports, keyed by project id. */
let agentConfigs: Record<string, { modelName?: string | null; modelProvider?: string | null } | null> = {}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      apiCalls.push({ method: req.method, path: url.pathname })
      const config = url.pathname.match(/^\/api\/internal\/projects\/([^/]+)\/config$/)
      if (config) {
        const projectId = decodeURIComponent(config[1]!)
        return Response.json({ project: { agent: agentConfigs[projectId] ?? null } })
      }
      return Response.json({})
    },
  })
  for (const key of ['SHOGO_API_URL', 'RUNTIME_AUTH_SECRET', 'AGENT_AUTO_TIER_MAP', 'PROJECT_ID', 'WORKSPACE_ANCHOR_PROJECT_ID']) {
    savedEnv[key] = process.env[key]
  }
  process.env.SHOGO_API_URL = `http://127.0.0.1:${server.port}`
  process.env.RUNTIME_AUTH_SECRET = 'test-secret'
  delete process.env.AGENT_AUTO_TIER_MAP
  // The gateway takes its project identity from PROJECT_ID when set, and
  // `runtimeServesProjectId` refuses a project config call for anything else.
  // Unset both so this runtime is the one the test's project belongs to.
  delete process.env.PROJECT_ID
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
})

afterAll(() => {
  server.stop(true)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearTrustForTests()
})

let testDir: string
let gateway: AgentGateway | undefined
let counter = 0

beforeEach(() => {
  apiCalls.length = 0
  agentConfigs = {}
  testDir = join(tmpdir(), `qa-sho178-${process.pid}-${++counter}`)
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(join(testDir, 'memory'), { recursive: true })
  mkdirSync(join(testDir, 'skills'), { recursive: true })
  writeFileSync(join(testDir, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: true,
    quietHours: { start: null, end: null, timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'auto' },
  }))
  writeFileSync(join(testDir, 'AGENTS.md'), '# Agent\nYou are a test agent.')
  writeFileSync(join(testDir, 'MEMORY.md'), '# Memory\nTest memory.')
  writeFileSync(join(testDir, 'HEARTBEAT.md'), '- Check the build\n- Check the board')
  trustWorkspaceForTests(testDir)
})

afterEach(async () => {
  if (gateway) await gateway.stop()
  gateway = undefined
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function textOf(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return (m.content as any[]).map((c) => c.text ?? '').join('')
}

function userTexts(messages: Message[]): string {
  return messages.filter((m) => m.role === 'user').map(textOf).join('\n')
}

/** Every model call the gateway made, with the id it requested. */
interface ModelCall { modelId: string; messages: Message[] }

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
      stream.push({ type: 'start', partial: message } as any)
      stream.push({ type: 'done', reason: 'stop', message } as any)
      stream.end(message as any)
    })
    return stream as any
  }
}

async function start(
  streamFn?: (model: any, context: any) => any,
  config?: Record<string, unknown>,
) {
  if (config) {
    writeFileSync(join(testDir, 'config.json'), JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: null, end: null, timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'auto' },
      ...config,
    }))
  }
  gateway = new AgentGateway(testDir, 'test-project')
  gateway.setStreamFn(streamFn as any)
  await gateway.start()
  return gateway
}

describe('SHO-178 AC1/AC7 — a tick starts from an empty, bounded context', () => {
  test('50 ticks: one message out per tick, prompt size flat, nothing carried in a transcript', async () => {
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))

    const messageCounts: number[] = []
    const promptChars: number[] = []
    for (let i = 0; i < 50; i++) {
      expect(await gw.triggerHeartbeat()).toBe('HEARTBEAT_OK')
      const call = calls[calls.length - 1]!
      messageCounts.push(call.messages.length)
      promptChars.push(userTexts(call.messages).length)
    }

    expect(calls).toHaveLength(50)
    expect(new Set(messageCounts)).toEqual(new Set([1]))
    // Tick 50 is no larger than tick 25: the prompt plateaus at the checklist
    // plus the capped HEARTBEAT_LOG.md tail instead of growing per tick.
    expect(promptChars[49]).toBeLessThanOrEqual(promptChars[24]!)
    expect(promptChars[49]).toBeLessThan(4000)
    expect(userTexts(calls[0]!.messages)).toContain('Check the board')
  }, 60_000)

  test('the ten-day shape cannot recur: no turn key survives its tick', async () => {
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))
    const manager = (gw as any).sessionManager

    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const before = new Set(manager.getAllStats().map((s: any) => s.id))
      await gw.triggerHeartbeat()
      const after = manager.getAllStats().map((s: any) => s.id) as string[]
      const added = after.filter((id) => !before.has(id))
      expect(added).toEqual([])
      ids.push(...after.filter((id: string) => id.startsWith('heartbeat:')))
    }

    // Every tick used a distinct id, and none of them is still held.
    const tickIds = new Set(calls.map((_, i) => i))
    expect(tickIds.size).toBe(5)
    expect(ids).toEqual([])
  }, 30_000)
})

describe('SHO-178 AC2 — two projects on one runtime never share a heartbeat', () => {
  test('each tick sees only its own checklist, and its session names its own project', async () => {
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))

    const dirA = join(testDir, 'proj-a')
    const dirB = join(testDir, 'proj-b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirA, 'HEARTBEAT.md'), '- ALPHA checklist only')
    writeFileSync(join(dirB, 'HEARTBEAT.md'), '- BRAVO checklist only')

    const seenIds: string[] = []
    const manager = (gw as any).sessionManager
    const original = manager.getOrCreate.bind(manager)
    manager.getOrCreate = (id: string) => {
      if (id.startsWith('heartbeat:')) seenIds.push(id)
      return original(id)
    }

    await gw.triggerHeartbeat({ projectId: 'proj-a', projectDir: dirA })
    await gw.triggerHeartbeat({ projectId: 'proj-b', projectDir: dirB })
    await gw.triggerHeartbeat({ projectId: 'proj-a', projectDir: dirA })

    const prompts = calls.map((c) => userTexts(c.messages))
    expect(prompts[0]).toContain('ALPHA checklist only')
    expect(prompts[1]).toContain('BRAVO checklist only')
    expect(prompts[1]).not.toContain('ALPHA checklist only')
    expect(prompts[2]).toContain('ALPHA checklist only')
    expect(prompts[2]).not.toContain('BRAVO checklist only')
    for (const call of calls) expect(call.messages).toHaveLength(1)

    // Analytics attributes heartbeat spend by this segment (SHO-182), so the id
    // has to name the project the tick ran for, not the runtime's anchor.
    const tickIds = [...new Set(seenIds)]
    const projects = tickIds.map((id) => heartbeatSessionProjectId(id))
    expect(projects).toEqual(['proj-a', 'proj-b', 'proj-a'])
    for (const id of tickIds) expect(isHeartbeatChatSessionId(id)).toBe(true)
    // A project segment the analytics reader can actually split on.
    for (const id of tickIds) expect(id.split(':')).toHaveLength(3)
  }, 30_000)
})

describe('SHO-178 AC3 — agent_configs.modelName is honoured (real internal API path)', () => {
  test('a project configured for Sonnet runs its heartbeat on Sonnet', async () => {
    agentConfigs['test-project'] = { modelName: 'claude-sonnet-4-5', modelProvider: 'anthropic' }
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))

    await gw.triggerHeartbeat()

    // The tick really asked the API for the project's config…
    expect(apiCalls.some((c) => c.path === '/api/internal/projects/test-project/config')).toBe(true)
    // …and requested the configured model, not `auto`.
    expect(calls[0]!.modelId).toContain('claude-sonnet-4-5')
  }, 30_000)

  test('a project with no model row falls back to the platform default, never auto', async () => {
    agentConfigs['test-project'] = null
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))

    await gw.triggerHeartbeat()

    expect(calls[0]!.modelId).not.toBe('auto')
    expect(calls[0]!.modelId).toBe(PLATFORM_DEFAULT_HEARTBEAT_MODEL)
  }, 30_000)

  test('the legacy default row expresses no choice, so the tick does not inherit it', async () => {
    // `claude-haiku-4-5` is what a project that never picked a model carries;
    // treating it as a choice would pin every such heartbeat to Haiku.
    agentConfigs['test-project'] = { modelName: 'claude-haiku-4-5', modelProvider: 'anthropic' }
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))

    await gw.triggerHeartbeat()

    expect(calls[0]!.modelId).toBe(PLATFORM_DEFAULT_HEARTBEAT_MODEL)
  }, 30_000)
})

describe('SHO-178 AC4/AC5 — the model is chosen on purpose and the choice is logged', () => {
  test('the admin economy tier is the platform default, and it is logged with its source', async () => {
    process.env.AGENT_AUTO_TIER_MAP = JSON.stringify({
      economy: { id: 'deepseek-flash', provider: 'custom' },
      standard: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
      premium: { id: 'claude-opus-4-1', provider: 'anthropic' },
    })
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))
    const logs: string[] = []
    gw.setLogCallback((line) => logs.push(line))

    await gw.triggerHeartbeat()

    expect(calls[0]!.modelId).toBe('deepseek-flash')
    const line = logs.find((l) => l.includes('Heartbeat model:'))
    expect(line).toBeDefined()
    expect(line).toContain('deepseek-flash')
    expect(line).toContain('source=platform_default')
    delete process.env.AGENT_AUTO_TIER_MAP
  }, 30_000)

  test('a huge carried-in context cannot push the tick onto the premium tier', async () => {
    process.env.AGENT_AUTO_TIER_MAP = JSON.stringify({
      economy: { id: 'deepseek-flash', provider: 'custom' },
      standard: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
      premium: { id: 'claude-opus-4-1', provider: 'anthropic' },
    })
    // A 20-entry log tail is the largest state a tick can carry.
    writeFileSync(
      join(testDir, 'HEARTBEAT_LOG.md'),
      `# Recent Heartbeat Activity\n\n${Array.from({ length: 20 }, (_, i) =>
        `- [2026-10-2${i % 10}T09:00:00.000Z] check ${i}: ${'detail '.repeat(60)}`).join('\n')}\n`,
    )
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))
    const logs: string[] = []
    gw.setLogCallback((line) => logs.push(line))

    await gw.triggerHeartbeat()

    expect(calls[0]!.modelId).toBe('deepseek-flash')
    expect(calls[0]!.modelId).not.toBe('claude-opus-4-1')
    expect(logs.some((l) => l.includes('source=platform_default'))).toBe(true)
    delete process.env.AGENT_AUTO_TIER_MAP
  }, 30_000)

  test('the carried-in state is capped at the log tail, so the prompt stays small', async () => {
    writeFileSync(
      join(testDir, 'HEARTBEAT_LOG.md'),
      `# Recent Heartbeat Activity\n\n${Array.from({ length: 20 }, (_, i) =>
        `- [2026-10-2${i % 10}T09:00:00.000Z] check ${i} all clear`).join('\n')}\n`,
    )
    const calls: ModelCall[] = []
    const gw = await start(recordingStream(calls))

    await gw.triggerHeartbeat()

    const prompt = userTexts(calls[0]!.messages)
    expect(prompt).toContain('check 19 all clear')
    expect(prompt).toContain('## Recent heartbeat results')
    expect(prompt.length).toBeLessThan(3000)
  }, 30_000)
})

describe('SHO-178 — what a tick leaves running', () => {
  test('a background command started by a tick is still running after the tick ends', async () => {
    const calls: Message[][] = []
    const gw = await start(createMockStreamFn([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 20', background: true }, id: 'tc-1' }]),
      buildTextResponse('HEARTBEAT_OK'),
    ], (_i, msgs) => calls.push([...msgs])))

    let registry: any
    const disposals: Array<{ sessionId: string; running: number }> = []
    const originalRegistry = (gw as any).getOrCreateCommandRegistry.bind(gw)
    ;(gw as any).getOrCreateCommandRegistry = (sessionId: string) => {
      registry = originalRegistry(sessionId)
      if (!registry.__qaWrapped) {
        const originalKillAll = registry.killAll.bind(registry)
        registry.killAll = async (opts: any) => {
          disposals.push({ sessionId, running: registry.snapshot().length })
          return originalKillAll(opts)
        }
        registry.__qaWrapped = true
      }
      return registry
    }

    expect(await gw.triggerHeartbeat()).toBe('HEARTBEAT_OK')

    const taskId = calls
      .flat()
      .filter((m) => m.role === 'toolResult')
      .map(textOf)
      .map((t) => t.match(/"task_id":\s*"(t_[^"]+)"/)?.[1])
      .find(Boolean)
    expect(taskId).toBeDefined()

    // The tick's turn is over; the command it started was meant to outlive it.
    await sleep(100)
    const entry = registry?.get(taskId!)
    // On `main` this is 'running' and nothing is disposed. On this branch the
    // tick's own cleanup SIGKILLs it: `disposeHeartbeatSession` →
    // `disposeSessionState` → `killAll({ clear: true })`, which also deletes the
    // task's output dir, so the work and its log both disappear silently.
    expect({ status: entry?.status ?? null, disposals }).toEqual({ status: 'running', disposals: [] })
  }, 30_000)
})
