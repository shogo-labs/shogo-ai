// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A run killed mid-tool must say so on the next boot, resume once, and never
 * resume again (SHO-121).
 *
 * The crash is simulated the way the real one leaves state behind: a persisted
 * session whose metadata carries an `inflightTurn` marker and whose last
 * assistant message has a tool call with no result. Then the gateway is
 * started twice.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { buildTextResponse } from '../pi-adapter'
import { clearSessionTodos } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'

/** A canned stream that yields one text answer and records the prompt it was given. */
function recordingStream(onPrompt?: (prompt: string) => void): StreamFn {
  return ((_model: any, context: any) => {
    const lastUser = [...context.messages].reverse().find((message: any) => message.role === 'user')
    onPrompt?.(typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? ''))
    const message: AssistantMessage = buildTextResponse('Deploy finished.')
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'done', reason: 'stop', message })
      stream.end(message)
    })
    return stream as any
  }) as StreamFn
}

let testCounter = 0
const makeTestDir = () => join(tmpdir(), `test-interrupted-turn-${process.pid}-${++testCounter}`)

function setupWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo'), { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(join(dir, 'AGENTS.md'), '# Agent\nYou are a test agent.')
}

const SESSION_ID = 'interrupted-session'

/** The transcript a killed run leaves: a user turn and an unanswered tool call. */
const interruptedMessages = (): Message[] =>
  [
    { role: 'user', content: 'Deploy the app', timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tu_exec', name: 'exec', arguments: { command: 'bun run deploy' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 2,
    },
  ] as unknown as Message[]

function markerAge(ms: number) {
  return {
    inflightTurn: { id: 'turn-1', startedAt: Date.now() - ms, lastTool: 'exec', resumeAttempts: 0 },
  }
}

describe('interrupted-turn recovery (SHO-121)', () => {
  let testDir: string
  let gateway: AgentGateway
  const previous = {
    resume: process.env.AGENT_RESUME_MAX_AGE_MINUTES,
    plan: process.env.AGENT_MAX_PLAN_CONTINUATIONS,
  }

  beforeEach(async () => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
    trustWorkspaceForTests(testDir)
    delete process.env.AGENT_RESUME_MAX_AGE_MINUTES
    process.env.AGENT_MAX_PLAN_CONTINUATIONS = '0'
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    clearTrustForTests()
    clearSessionTodos(SESSION_ID)
    rmSync(testDir, { recursive: true, force: true })
    for (const [key, value] of [
      ['AGENT_RESUME_MAX_AGE_MINUTES', previous.resume],
      ['AGENT_MAX_PLAN_CONTINUATIONS', previous.plan],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  /** Seed the on-disk session a killed runtime would leave behind. */
  async function seedInterrupted(metadata: Record<string, any>) {
    const persistence = new SqliteSessionPersistence(testDir)
    await persistence.save(SESSION_ID, {
      id: SESSION_ID,
      messages: interruptedMessages(),
      compactedSummary: null,
      createdAt: Date.now() - 60_000,
      lastActivityAt: Date.now() - 60_000,
      totalMessages: 2,
      compactionCount: 0,
      metadata,
    })
  }

  async function storedMetadata(): Promise<Record<string, any>> {
    const persistence = new SqliteSessionPersistence(testDir)
    const data = await persistence.load(SESSION_ID)
    return (data?.metadata ?? {}) as Record<string, any>
  }

  test('says it was interrupted and resumes exactly once', async () => {
    await seedInterrupted(markerAge(60_000))

    const prompts: string[] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(recordingStream((prompt) => prompts.push(prompt)))

    await gateway.start()
    // The resume runs as its own turn; keep this deterministic instead of
    // sleeping: wait until the resumed answer is in the session.
    const answered = () =>
      !!gateway
        .getSessionManager()
        .get(SESSION_ID)
        ?.messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Deploy finished'))
    const deadline = Date.now() + 5_000
    while (!answered() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('I was interrupted while running `exec` — resuming.')
    expect(prompts[0]).toContain('Pick up exactly where you left off. Do not start over.')

    // The interrupted tool got a result that says it did not return, so the
    // resumed model cannot read it as a success.
    const resumed = gateway.getSessionManager().get(SESSION_ID)!
    const synthetic = resumed.messages.find(
      (message) => message.role === 'toolResult' && JSON.stringify(message.content).includes('Interrupted before this tool returned'),
    )
    expect(synthetic).toBeDefined()

    // The turn completed, so no marker survives it.
    await gateway.stop()
    gateway = undefined as any
    expect((await storedMetadata()).inflightTurn ?? null).toBeNull()
  })

  test('a resume that also died posts the note but never resumes again', async () => {
    // resumeAttempts 1 is what the resumed turn's own marker carries when *it*
    // dies, so the next boot must not start a third attempt.
    await seedInterrupted({
      inflightTurn: { id: 'turn-2', startedAt: Date.now() - 30_000, lastTool: 'exec', resumeAttempts: 1 },
    })

    let modelCalls = 0
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn((() => {
      modelCalls++
      throw new Error('no model call may happen on a second boot')
    }) as any)
    await gateway.start()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(modelCalls).toBe(0)
    // The marker is consumed either way, so a further restart stays quiet.
    expect((await storedMetadata()).inflightTurn ?? null).toBeNull()
  })

  test('a marker older than AGENT_RESUME_MAX_AGE_MINUTES is ignored', async () => {
    process.env.AGENT_RESUME_MAX_AGE_MINUTES = '5'
    await seedInterrupted(markerAge(60 * 60_000))

    let modelCalls = 0
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn((() => {
      modelCalls++
      throw new Error('a turn older than the TTL must not run')
    }) as any)
    await gateway.start()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(modelCalls).toBe(0)
    expect((await storedMetadata()).inflightTurn ?? null).toBeNull()
  })

  test('AGENT_RESUME_MAX_AGE_MINUTES=0 disables the sweep', async () => {
    process.env.AGENT_RESUME_MAX_AGE_MINUTES = '0'
    await seedInterrupted(markerAge(60_000))

    let modelCalls = 0
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn((() => {
      modelCalls++
      throw new Error('the sweep is disabled')
    }) as any)
    await gateway.start()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(modelCalls).toBe(0)
    // Left exactly as it was, so turning the switch back on still recovers it.
    expect((await storedMetadata()).inflightTurn?.resumeAttempts).toBe(0)
  })
})
