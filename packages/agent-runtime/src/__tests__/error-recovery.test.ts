// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Error Recovery Tests
 *
 * Validates that the agent loop and gateway handle errors correctly:
 * - AgentLoopResult includes an `error` field instead of throwing
 * - The gateway persists partial messages to the session even on error
 * - A subsequent "continue" message picks up where the agent left off
 *
 * Run: bun test packages/agent-runtime/src/__tests__/error-recovery.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { runAgentLoop } from '../agent-loop'
import type { AgentLoopResult } from '../agent-loop'
import { AgentGateway } from '../gateway'
import type { Message, AssistantMessage, Usage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import {
  createMockStreamFn,
  buildTextResponse,
  buildToolUseResponse,
} from '../pi-adapter'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { MockToolTracker } from './helpers/mock-tools'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_OUTPUT_USAGE: Usage = {
  input: 100,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Create a StreamFn that throws synchronously.
 * Pi-agent-core catches this internally, so agent.prompt() resolves with
 * 0 output tokens rather than throwing. Use for testing graceful degradation.
 */
function createThrowingStreamFn(errorMessage: string): StreamFn {
  return (_model, _context, _options) => {
    throw new Error(errorMessage)
  }
}

/**
 * Create a StreamFn that succeeds for the first N calls then throws.
 * Simulates partial success (e.g., tool call completes but follow-up
 * LLM call fails due to provider error).
 */
function createFailAfterNStreamFn(
  successResponses: AssistantMessage[],
  errorMessage: string,
  onCall?: (index: number, messages: Message[]) => void,
): StreamFn {
  let idx = 0

  return (_model, context, options) => {
    const callIdx = idx++
    onCall?.(callIdx, context.messages)

    if (callIdx >= successResponses.length) {
      throw new Error(errorMessage)
    }

    const msg = successResponses[callIdx]
    const stream = createAssistantMessageEventStream()

    queueMicrotask(() => {
      stream.push({ type: 'start', partial: msg })
      const reason = msg.content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop'
      stream.push({ type: 'done', reason, message: msg })
      stream.end(msg)
    })

    return stream as any
  }
}

/**
 * Build a response with stopReason: 'error' to simulate an LLM-reported error.
 * Pi-agent-core emits an error event for this, which the agent loop can catch.
 */
function buildErrorResponse(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock-model',
    usage: ZERO_OUTPUT_USAGE,
    stopReason: 'error',
    timestamp: Date.now(),
  }
}

// ===========================================================================
// agent-loop: error field on AgentLoopResult
// ===========================================================================

describe('runAgentLoop error recovery', () => {
  test('returns result with error field when stream function throws (zero output)', async () => {
    // When pi-agent-core catches the stream error internally, runAgentLoop
    // detects 0 output tokens and sets a synthetic error on the result.
    const mockStream = createThrowingStreamFn('API rate limit exceeded')

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'You are a test agent.',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: mockStream,
    })

    expect(result).toBeDefined()
    expect(result.error).toBeDefined()
    expect(result.error!.message).toBeTruthy()
    expect(result.outputTokens).toBe(0)
    expect(result.toolCalls).toHaveLength(0)
  })

  test('preserves partial tool calls when provider fails on follow-up LLM call', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file data' })

    // First LLM call succeeds (tool use), second call fails (provider error).
    // Pi-agent-core catches the failure on the second call, so the loop ends
    // with the tool call recorded but no final text.
    const mockStream = createFailAfterNStreamFn(
      [buildToolUseResponse([{ name: 'read_file', arguments: { path: 'test.txt' }, id: 'toolu_1' }])],
      'API connection timeout',
    )

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Read test.txt',
      tools: [tool],
      streamFn: mockStream,
    })

    expect(result).toBeDefined()
    // The tool call should be preserved in the result
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
    // newMessages should contain the partial conversation (user + assistant tool call + tool result)
    expect(result.newMessages.length).toBeGreaterThan(0)
    const hasAssistant = result.newMessages.some((m) => m.role === 'assistant')
    expect(hasAssistant).toBe(true)
  })

  test('returns normal result (no error) on successful completion', async () => {
    const mockStream = createMockStreamFn([
      buildTextResponse('All good!'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: mockStream,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('All good!')
    expect(result.outputTokens).toBeGreaterThan(0)
  })

  test('newMessages contains user prompt even on immediate error', async () => {
    const mockStream = createThrowingStreamFn('Service unavailable')

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Do something',
      tools: [],
      streamFn: mockStream,
    })

    expect(result).toBeDefined()
    expect(result.error).toBeDefined()
    const hasUser = result.newMessages.some((m) => m.role === 'user')
    expect(hasUser).toBe(true)
  })

  test('returns result with error for LLM-reported error (stopReason: error)', async () => {
    const mockStream = createMockStreamFn([
      buildErrorResponse('Overloaded'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: mockStream,
    })

    // The LLM reported an error via stopReason — the result should surface it
    expect(result).toBeDefined()
    expect(result.error).toBeDefined()
  })
})

// ===========================================================================
// gateway: error recovery + session persistence
// ===========================================================================

const TEST_DIR = '/tmp/test-error-recovery-gateway'

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })

  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Agent\nYou are a test agent.')
}

describe('AgentGateway error recovery', () => {
  let gateway: AgentGateway

  beforeEach(() => {
    setupWorkspace()
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('persists partial messages to session after tool call + provider error', async () => {
    // Tool call succeeds, then follow-up LLM call fails
    const mockStream = createFailAfterNStreamFn(
      [buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }])],
      'API overloaded',
    )

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    await gateway.processChatMessage('Read a.txt')

    const session = gateway.getSessionManager().get('chat')
    expect(session).toBeDefined()
    expect(session!.messages.length).toBeGreaterThan(0)

    const hasUser = session!.messages.some((m) => m.role === 'user')
    const hasAssistant = session!.messages.some((m) => m.role === 'assistant')
    expect(hasUser).toBe(true)
    expect(hasAssistant).toBe(true)
  })

  test('subsequent "continue" message sees partial history from failed turn', async () => {
    // Phase 1: Tool call succeeds, then follow-up fails
    const mockStreamPhase1 = createFailAfterNStreamFn(
      [buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }])],
      'API overloaded',
    )

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStreamPhase1)
    await gateway.start()

    await gateway.processChatMessage('Read a.txt and summarize it')

    // Phase 2: User says "continue" — agent should see the partial history
    let messagesSentToLLM: Message[][] = []
    const mockStreamPhase2 = createMockStreamFn(
      [buildTextResponse('Here is the summary of a.txt: data')],
      (_idx, msgs) => { messagesSentToLLM.push([...msgs]) },
    )
    gateway.setStreamFn(mockStreamPhase2)

    const response = await gateway.processChatMessage('continue')

    expect(response).toBe('Here is the summary of a.txt: data')
    expect(messagesSentToLLM).toHaveLength(1)
    // History should include: original user + assistant tool call + tool result + "continue"
    expect(messagesSentToLLM[0].length).toBeGreaterThanOrEqual(3)
  })

  test('sends SSE error chunk to UI on zero-output provider error', async () => {
    const mockStream = createThrowingStreamFn('API rate limit exceeded')

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const writtenChunks: any[] = []
    const mockWriter = {
      write: (chunk: any) => { writtenChunks.push(chunk) },
    }

    await gateway.processChatMessageStream('Hello', mockWriter as any, {})

    const errorChunk = writtenChunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    expect(errorChunk.errorText).toBeTruthy()
  })

  test('persists user message to session even when stream sends error to UI', async () => {
    const mockStream = createThrowingStreamFn('Unauthorized: invalid API key')

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockWriter = { write: (_chunk: any) => {} }
    await gateway.processChatMessageStream('Hello', mockWriter as any, {})

    const session = gateway.getSessionManager().get('chat')
    expect(session).toBeDefined()
    expect(session!.messages.length).toBeGreaterThan(0)

    const hasUser = session!.messages.some((m) => m.role === 'user')
    expect(hasUser).toBe(true)
  })

  test('user message persists to session on immediate provider error', async () => {
    const mockStream = createThrowingStreamFn('Service unavailable')

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    await gateway.processChatMessage('Test message')

    const session = gateway.getSessionManager().get('chat')
    expect(session).toBeDefined()
    const hasUser = session!.messages.some((m) => m.role === 'user')
    expect(hasUser).toBe(true)
  })

  test('error does not leave session in a corrupt state for next turn', async () => {
    // Phase 1: Error
    const mockStreamError = createThrowingStreamFn('Temporary outage')
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStreamError)
    await gateway.start()

    await gateway.processChatMessage('First message')

    // Phase 2: Recovery — next turn should work normally
    const mockStreamOk = createMockStreamFn([
      buildTextResponse('I am back and working!'),
    ])
    gateway.setStreamFn(mockStreamOk)

    const response = await gateway.processChatMessage('Are you working?')
    expect(response).toBe('I am back and working!')

    // Session should have messages from both turns
    const session = gateway.getSessionManager().get('chat')
    expect(session).toBeDefined()
    const userMsgs = session!.messages.filter((m) => m.role === 'user')
    expect(userMsgs.length).toBeGreaterThanOrEqual(2)
  })
})
