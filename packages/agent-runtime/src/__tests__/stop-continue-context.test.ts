// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stop / Continue Context Tests
 *
 * Validates that when a user stops a response mid-stream and then sends
 * "continue", the agent retains full context from the interrupted turn:
 *
 * - Fix 1: addMessages() persists to session even when uiWriter throws
 * - Fix 2: abortCurrentTurn() actually cancels a running turn
 * - Fix 3: Concurrent turns wait for the previous turn to complete
 * - Fix 4: (URL fix — tested at the ChatPanel level, not here)
 *
 * Run: bun test packages/agent-runtime/src/__tests__/stop-continue-context.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentGateway } from '../gateway'
import type { Message, AssistantMessage, Usage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import {
  createMockStreamFn,
  buildTextResponse,
} from '../pi-adapter'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0

function makeTestDir(): string {
  return join(tmpdir(), `test-stop-continue-${process.pid}-${++testCounter}`)
}

function setupWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })

  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
  )
  writeFileSync(join(dir, 'AGENTS.md'), '# Agent\nYou are a test agent.')
}

function safeCleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // On Windows, background processes may still hold handles briefly after
    // gateway.stop(). Best-effort cleanup; the OS temp dir is ephemeral.
  }
}

const EMPTY_USAGE: Usage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function createDelayedStreamFn(
  responses: AssistantMessage[],
  delayMs: number,
  onCall?: (index: number, messages: Message[]) => void,
): StreamFn {
  let idx = 0
  return (_model, context, _options) => {
    const responseIdx = Math.min(idx, responses.length - 1)
    const msg = responses[responseIdx]
    idx++
    onCall?.(responseIdx, context.messages)
    const stream = createAssistantMessageEventStream()
    setTimeout(() => {
      stream.push({ type: 'start', partial: msg })
      const reason = msg.content.some((c: any) => c.type === 'toolCall') ? 'toolUse' : 'stop'
      stream.push({ type: 'done', reason, message: msg })
      stream.end(msg)
    }, delayMs)
    return stream as any
  }
}

function createThrowingWriter(throwAfterType: string) {
  const chunks: any[] = []
  let thrown = false
  return {
    writer: {
      write(chunk: any) {
        chunks.push(chunk)
        if (!thrown && chunk.type === throwAfterType) {
          thrown = true
          throw new Error('Client disconnected')
        }
      },
    },
    chunks,
  }
}

function createCollectingWriter() {
  const chunks: any[] = []
  return {
    writer: { write(chunk: any) { chunks.push(chunk) } },
    chunks,
  }
}

// ===========================================================================
// Fix 1: addMessages persists despite writer throw
// ===========================================================================

describe('Fix 1: addMessages persists to session when uiWriter throws', () => {
  let gateway: AgentGateway
  let testDir: string

  beforeEach(() => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
  })
  afterEach(async () => {
    if (gateway) await gateway.stop()
    safeCleanup(testDir)
  })

  test('session contains turn messages even when writer throws after text-end', async () => {
    const mockStream = createMockStreamFn([
      buildTextResponse('Here is my response about quantum computing.'),
    ])

    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const { writer } = createThrowingWriter('text-end')

    await gateway.processChatMessageStream('Explain quantum computing', writer as any, {})

    const session = gateway.getSessionManager().get('chat')
    expect(session).toBeDefined()
    expect(session!.messages.length).toBeGreaterThan(0)

    const hasUser = session!.messages.some((m) => m.role === 'user')
    const hasAssistant = session!.messages.some((m) => m.role === 'assistant')
    expect(hasUser).toBe(true)
    expect(hasAssistant).toBe(true)
  })

  test('"continue" sees interrupted turn context when writer fails mid-stream', async () => {
    const mockStreamPhase1 = createMockStreamFn([
      buildTextResponse('Quantum computing uses qubits which...'),
    ])

    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(mockStreamPhase1)
    await gateway.start()

    const { writer: throwingWriter } = createThrowingWriter('text-end')
    await gateway.processChatMessageStream('Explain quantum computing', throwingWriter as any, {})

    let messagesSentToLLM: Message[][] = []
    const mockStreamPhase2 = createMockStreamFn(
      [buildTextResponse('...can exist in superposition, enabling parallel computation.')],
      (_idx, msgs) => { messagesSentToLLM.push([...msgs]) },
    )
    gateway.setStreamFn(mockStreamPhase2)

    const { writer: normalWriter } = createCollectingWriter()
    await gateway.processChatMessageStream('continue', normalWriter as any, {})

    expect(messagesSentToLLM).toHaveLength(1)
    const history = messagesSentToLLM[0]

    expect(history.length).toBeGreaterThanOrEqual(3)
    const userMessages = history.filter((m) => m.role === 'user')
    const assistantMessages = history.filter((m) => m.role === 'assistant')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// Fix 2: abortCurrentTurn actually cancels and persists
// ===========================================================================

describe('Fix 2: abortCurrentTurn cancels running turn', () => {
  let gateway: AgentGateway
  let testDir: string

  beforeEach(() => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
  })
  afterEach(async () => {
    if (gateway) await gateway.stop()
    safeCleanup(testDir)
  })

  test('abortCurrentTurn returns true for an in-flight turn', async () => {
    const mockStream = createDelayedStreamFn(
      [buildTextResponse('This response takes a while...')],
      500,
    )

    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const { writer } = createCollectingWriter()
    const turnPromise = gateway.processChatMessageStream('Hello', writer as any, {})

    await new Promise((r) => setTimeout(r, 50))
    const aborted = gateway.abortCurrentTurn('chat')
    expect(aborted).toBe(true)

    await turnPromise

    const session = gateway.getSessionManager().get('chat')
    expect(session).toBeDefined()
    const hasUser = session!.messages.some((m) => m.role === 'user')
    expect(hasUser).toBe(true)
  })

  test('abort + continue preserves context (full scenario)', async () => {
    const mockStreamSlow = createDelayedStreamFn(
      [buildTextResponse('Slow partial response content...')],
      500,
    )

    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(mockStreamSlow)
    await gateway.start()

    const { writer: writer1 } = createCollectingWriter()
    const turn1 = gateway.processChatMessageStream('Write something complex', writer1 as any, {})

    await new Promise((r) => setTimeout(r, 50))
    gateway.abortCurrentTurn('chat')
    await turn1

    let messagesSentToLLM: Message[][] = []
    const mockStreamFast = createMockStreamFn(
      [buildTextResponse('Continuing from where we left off...')],
      (_idx, msgs) => { messagesSentToLLM.push([...msgs]) },
    )
    gateway.setStreamFn(mockStreamFast)

    const { writer: writer2 } = createCollectingWriter()
    await gateway.processChatMessageStream('continue', writer2 as any, {})

    expect(messagesSentToLLM).toHaveLength(1)
    const history = messagesSentToLLM[0]

    const userTexts = history
      .filter((m) => m.role === 'user')
      .map((m: any) =>
        typeof m.content === 'string'
          ? m.content
          : m.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || ''
      )
    const hasOriginalPrompt = userTexts.some((t: string) => t.includes('Write something complex'))
    expect(hasOriginalPrompt).toBe(true)
  })
})

// ===========================================================================
// Fix 3: Concurrent turn waits for previous turn to complete
// ===========================================================================

describe('Fix 3: concurrent turn waits for previous turn', () => {
  let gateway: AgentGateway
  let testDir: string

  beforeEach(() => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
  })
  afterEach(async () => {
    if (gateway) await gateway.stop()
    safeCleanup(testDir)
  })

  test('second turn sees first turn messages in history', async () => {
    let callCount = 0
    let messagesSentToLLM: Message[][] = []

    const mockStream: StreamFn = (_model, context, _options) => {
      const idx = callCount++
      messagesSentToLLM.push([...context.messages])

      const msg: AssistantMessage = idx === 0
        ? buildTextResponse('First response content')
        : buildTextResponse('Second response acknowledging first')

      const stream = createAssistantMessageEventStream()
      const delay = idx === 0 ? 200 : 10
      setTimeout(() => {
        stream.push({ type: 'start', partial: msg })
        stream.push({ type: 'done', reason: 'stop', message: msg })
        stream.end(msg)
      }, delay)
      return stream as any
    }

    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const { writer: w1 } = createCollectingWriter()
    const { writer: w2 } = createCollectingWriter()

    const turn1 = gateway.processChatMessageStream('First message', w1 as any, {})
    const turn2 = gateway.processChatMessageStream('continue', w2 as any, {})

    await Promise.all([turn1, turn2])

    expect(messagesSentToLLM.length).toBe(2)

    const turn2History = messagesSentToLLM[1]
    expect(turn2History.length).toBeGreaterThanOrEqual(3)

    const hasFirstUserMsg = turn2History.some((m: any) => {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || ''
      return text.includes('First message')
    })
    const hasFirstAssistantMsg = turn2History.some((m: any) => {
      if (m.role !== 'assistant') return false
      const text = m.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || ''
      return text.includes('First response content')
    })

    expect(hasFirstUserMsg).toBe(true)
    expect(hasFirstAssistantMsg).toBe(true)
  })
})
