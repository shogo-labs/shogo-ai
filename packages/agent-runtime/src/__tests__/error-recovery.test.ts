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
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { runAgentLoop, RetryWaker } from '../agent-loop'
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

// These tests assert how a failed turn surfaces, so the provider backoff tier
// (real timers, unlimited by default) is off here; the Layer 8 tests
// opt back in with an explicit budget and a fake clock.
const originalProviderRetry = process.env.SHOGO_PROVIDER_RETRY
beforeAll(() => {
  process.env.SHOGO_PROVIDER_RETRY = 'off'
})
afterAll(() => {
  if (originalProviderRetry === undefined) delete process.env.SHOGO_PROVIDER_RETRY
  else process.env.SHOGO_PROVIDER_RETRY = originalProviderRetry
})

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

  test('usage limit mid-turn ends with a clear notice and no finalizer or continuation', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file data' })
    let calls = 0
    const mockStream = createFailAfterNStreamFn(
      [buildToolUseResponse([{ name: 'read_file', arguments: { path: 'test.txt' }, id: 'toolu_1' }])],
      '402 {"error":{"message":"Usage limit reached. Enable usage-based pricing or upgrade your plan.",' +
        '"type":"billing_error","code":"usage_limit_reached","resetsAt":"2099-01-01T00:00:00.000Z","window":"5h"}}',
      () => { calls++ },
    )
    let streamed = ''

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Read test.txt',
      tools: [tool],
      streamFn: mockStream,
      onTextDelta: (d) => { streamed += d },
    })

    expect(calls).toBe(2)
    expect(result.error).toBeUndefined()
    expect(result.maxIterationsExhausted).toBe(false)
    expect(result.usageLimit).toEqual({ resetsAt: '2099-01-01T00:00:00.000Z', window: '5h' })
    expect(result.text).toContain("You've reached your usage limit")
    expect(result.text).toContain('I completed 1 step')
    expect(result.text).not.toContain('recoverable provider error')
    expect(streamed).toBe(result.text)
  })

  test('non-usage-limit provider error after tool calls keeps the recoverable fallback', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file data' })
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

    expect(result.usageLimit).toBeUndefined()
    expect(result.text).not.toContain('usage limit')
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
// agent-loop: inference reconnect/retry (Agent.continue)
// ===========================================================================

type ScriptStep = AssistantMessage | { throw: string }

/**
 * StreamFn driven by a script of steps. Each call consumes the next step
 * (clamped to the last so a single error step is "persistent"): an
 * `AssistantMessage` streams normally; a `{ throw }` step throws, which
 * pi-agent-core catches and surfaces as a trailing assistant `errorMessage`.
 */
function createScriptedStreamFn(
  steps: ScriptStep[],
  onCall?: (index: number, messages: Message[]) => void,
): { fn: StreamFn; getCalls: () => number } {
  let calls = 0
  const fn: StreamFn = (_model, context, _options) => {
    const i = calls++
    onCall?.(i, context.messages)
    const step = steps[Math.min(i, steps.length - 1)]
    if (step && (step as any).throw) {
      throw new Error((step as any).throw)
    }
    const msg = step as AssistantMessage
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: msg })
      const reason = msg.content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop'
      stream.push({ type: 'done', reason, message: msg })
      stream.end(msg)
    })
    return stream as any
  }
  return { fn, getCalls: () => calls }
}

const NO_BACKOFF = { computeDelayMs: () => 0, sleep: async () => {}, providerBackoff: false as const }

describe('runAgentLoop inference retry', () => {
  test('retryable mid-stream drop completes after retry', async () => {
    const { fn, getCalls } = createScriptedStreamFn([
      { throw: 'socket hang up' },
      buildTextResponse('Recovered answer'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: { maxAttempts: 2, ...NO_BACKOFF },
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Recovered answer')
    expect(getCalls()).toBe(2) // initial failure + one re-issue
  })

  test('no tool re-execution on retry; earlier tool result preserved', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file data' })

    // step0: tool use (executes the tool once)
    // step1: follow-up LLM call fails (retryable 5xx)
    // step2: re-issued follow-up succeeds with final text
    const { fn, getCalls } = createScriptedStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }]),
      { throw: '502 Bad Gateway' },
      buildTextResponse('Here is the file summary'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Read a.txt',
      tools: [tool],
      streamFn: fn,
      inferenceRetry: { maxAttempts: 2, ...NO_BACKOFF },
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Here is the file summary')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
    // Critical idempotency guarantee: the completed tool executed exactly once
    // across the failed attempt + successful retry.
    expect(tracker.getCallsFor('read_file')).toHaveLength(1)
    expect(getCalls()).toBe(3) // tool call + failed follow-up + retried follow-up
  })

  test('non-retryable error does not retry', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: '401 Unauthorized: invalid api key' }])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: { maxAttempts: 3, ...NO_BACKOFF },
    })

    expect(result.error).toBeDefined()
    expect(getCalls()).toBe(1) // no re-issue for a non-retryable failure
  })

  test('abort never retries', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'socket hang up' }])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      signal: controller.signal,
      inferenceRetry: { maxAttempts: 3, ...NO_BACKOFF },
    })

    // Aborted before the prompt ran: the stream fn is never invoked and the
    // retry loop is skipped (guarded by !abortTriggered).
    expect(getCalls()).toBe(0)
    expect(result.toolCalls).toHaveLength(0)
  })

  test('persistent retryable failure stops at the cap', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'ECONNRESET' }])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: { maxAttempts: 2, ...NO_BACKOFF },
    })

    // initial attempt + exactly maxAttempts re-issues, then give up
    expect(getCalls()).toBe(3)
    expect(result.error).toBeDefined()
  })

  test('backoff is invoked between attempts with increasing delay', async () => {
    const sleeps: number[] = []
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'fetch failed' }])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 3,
        computeDelayMs: (attempt) => attempt * 100,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        providerBackoff: false,
      },
    })

    expect(sleeps).toEqual([100, 200, 300])
    expect(getCalls()).toBe(4) // initial + 3 re-issues
  })

  test('connectivity park (Layer 7): survives an outage that outlasts the fast-retry budget, with no duplicate tool execution', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file data' })

    // step0: tool use (executes the tool once)
    // step1: follow-up fails (retryable) — detected as the initial failure
    // step2: the single fast-retry re-issue ALSO fails — fast budget exhausted
    // step3: the park-triggered re-issue (after "reconnecting") succeeds
    const { fn, getCalls } = createScriptedStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }]),
      { throw: 'ECONNRESET' },
      { throw: 'ECONNRESET' },
      buildTextResponse('Back online — here is the file summary'),
    ])

    // Fake clock/sleep so the backoff sequence inside waitForConnectivity
    // (1s/5s/15s) doesn't burn real wall-clock time in the test.
    let clockNow = 0
    const fakeSleep = async (ms: number) => { clockNow += ms }

    let probeCalls = 0
    const waitingTicks: Array<{ attempt: number; elapsedMs: number; nextProbeInMs: number }> = []
    let reconnectedFired = false

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Read a.txt',
      tools: [tool],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        ...NO_BACKOFF,
        connectivityWait: {
          probeUrl: 'https://fake-health.test/health',
          // Unreachable for the first 2 probes (simulating a real outage
          // the fast-retry tier can't ride out), reachable on the 3rd.
          probe: async () => {
            probeCalls++
            return probeCalls > 2
          },
          sleep: fakeSleep,
          now: () => clockNow,
        },
      },
      onConnectivityWait: (info) => waitingTicks.push(info),
      onConnectivityReconnected: () => { reconnectedFired = true },
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Back online — here is the file summary')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
    // The critical idempotency guarantee: the tool executed exactly once
    // across the failed attempt, the exhausted fast retry, AND the parked
    // reconnect — none of those re-run tools, only the dropped model call.
    expect(tracker.getCallsFor('read_file')).toHaveLength(1)
    expect(getCalls()).toBe(4)

    expect(probeCalls).toBe(3)
    expect(waitingTicks).toHaveLength(2) // one heartbeat per failed probe
    expect(waitingTicks.map((t) => t.attempt)).toEqual([1, 2])
    expect(reconnectedFired).toBe(true)
  })

  test('connectivity park: gives up (result.error set) when the outage never clears within maxWaitMs', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'socket hang up' }])

    let clockNow = 0
    const fakeSleep = async (ms: number) => { clockNow += ms }

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        ...NO_BACKOFF,
        connectivityWait: {
          probeUrl: 'https://fake-health.test/health',
          probe: async () => false, // never comes back
          sleep: fakeSleep,
          now: () => clockNow,
          maxWaitMs: 2_000, // smaller than a single backoff step
        },
      },
    })

    expect(result.error).toBeDefined()
    // initial attempt + 1 fast retry; the park tier probes/backs off purely
    // via the injected fake clock/probe, never re-issuing the model call.
    expect(getCalls()).toBe(2)
  })

  test('connectivity park does not engage when connectivityWait is not configured (fails fast, unchanged legacy behavior)', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'ECONNRESET' }])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: { maxAttempts: 1, ...NO_BACKOFF }, // no connectivityWait
    })

    expect(result.error).toBeDefined()
    expect(getCalls()).toBe(2) // initial + 1 fast retry, then gives up — no park
  })

  function fakeBackoffClock() {
    let clockNow = 0
    const sleeps: number[] = []
    return {
      sleeps,
      now: () => clockNow,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        clockNow += ms
      },
    }
  }

  test('provider backoff (Layer 8): rides out an overload that outlasts the fast budget, with no duplicate tool execution', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file data' })
    const { fn, getCalls } = createScriptedStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }]),
      { throw: '529 overloaded_error: Overloaded' },
      { throw: '529 overloaded_error: Overloaded' },
      { throw: '529 overloaded_error: Overloaded' },
      { throw: '503 Service Unavailable' },
      buildTextResponse('Here is the file summary'),
    ])
    const clock = fakeBackoffClock()
    const ticks: Array<{ attempt: number; reason: string; delayMs: number }> = []

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Read a.txt',
      tools: [tool],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        computeDelayMs: () => 0,
        sleep: async () => {},
        providerBackoff: {
          maxWaitMs: 180_000,
          computeDelayMs: (attempt) => attempt * 1_000,
          sleep: clock.sleep,
          now: clock.now,
        },
      },
      onProviderBackoff: (info) => ticks.push({ attempt: info.attempt, reason: info.reason, delayMs: info.delayMs }),
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Here is the file summary')
    expect(tracker.getCallsFor('read_file')).toHaveLength(1)
    // tool call + failed follow-up + 1 fast retry + 2 backoff retries that fail + 1 that succeeds
    expect(getCalls()).toBe(6)
    expect(ticks).toEqual([
      { attempt: 1, reason: 'overloaded', delayMs: 1_000 },
      { attempt: 2, reason: 'overloaded', delayMs: 2_000 },
      { attempt: 3, reason: 'server_5xx', delayMs: 3_000 },
    ])
    expect(clock.sleeps).toEqual([1_000, 2_000, 3_000])
  })

  test('provider backoff: gives up at maxWaitMs and surfaces the real error, not "no output"', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'socket hang up' }])
    const clock = fakeBackoffClock()

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        computeDelayMs: () => 0,
        sleep: async () => {},
        providerBackoff: {
          maxWaitMs: 60_000,
          computeDelayMs: () => 25_000,
          sleep: clock.sleep,
          now: clock.now,
        },
      },
    })

    // 25s + 25s + a final 10s clamped to the remaining budget, then give up.
    expect(clock.sleeps).toEqual([25_000, 25_000, 10_000])
    expect(getCalls()).toBe(5) // initial + 1 fast retry + 3 backoff retries
    expect(result.error?.message).toContain('socket hang up')
    expect(result.error?.message).not.toContain('no output')
  })

  test('provider backoff: a reachable network with a failing provider backs off instead of resetting the fast budget forever', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: '503 Service Unavailable' }])
    const clock = fakeBackoffClock()
    let reconnected = false
    let probes = 0

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 2,
        computeDelayMs: () => 0,
        sleep: async () => {},
        connectivityWait: {
          probeUrl: 'https://fake-health.test/health',
          probe: async () => {
            probes++
            return true
          },
        },
        providerBackoff: {
          maxWaitMs: 180_000,
          maxAttempts: 4,
          computeDelayMs: () => 1_000,
          sleep: clock.sleep,
          now: clock.now,
        },
      },
      onConnectivityReconnected: () => { reconnected = true },
    })

    expect(result.error).toBeDefined()
    // initial + 2 fast retries + 4 backoff retries; the fast budget is never reset.
    expect(getCalls()).toBe(7)
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000, 1_000])
    expect(probes).toBe(5) // one probe per failure after the fast budget is spent
    expect(reconnected).toBe(false)
  })

  test('provider backoff: unlimited by default — keeps retrying until the user stops the turn', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: '529 overloaded_error: Overloaded' }])
    const controller = new AbortController()
    let clockNow = 0
    const episodes: any[] = []
    const ticks: any[] = []

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      signal: controller.signal,
      inferenceRetry: {
        maxAttempts: 1,
        computeDelayMs: () => 0,
        sleep: async () => {},
        providerBackoff: {
          computeDelayMs: () => 30_000,
          sleep: async (ms) => {
            clockNow += ms
            // Well past any old budget (180s / 12 attempts) before the user stops.
            if (clockNow >= 30 * 60_000) controller.abort()
          },
          now: () => clockNow,
        },
      },
      onProviderBackoff: (info) => ticks.push(info),
      onRetryEpisodeEnd: (s) => episodes.push(s),
    })

    expect(ticks.length).toBe(60)
    expect(ticks[0].maxWaitMs).toBe(Infinity)
    expect(getCalls()).toBe(2 + 59) // initial + fast retry + backoff re-issues before the abort
    expect(episodes).toHaveLength(1)
    expect(episodes[0]).toMatchObject({ layer: 'provider_backoff', reason: 'overloaded', outcome: 'user_stopped' })
    expect(result.error?.message ?? '').not.toContain('no output')
  })

  test('provider backoff: flags suspectedDeterministic after repeated identical failures, but keeps retrying', async () => {
    const steps: ScriptStep[] = Array.from({ length: 9 }, () => ({ throw: '503 Service Unavailable' }))
    steps.push(buildTextResponse('finally'))
    const { fn } = createScriptedStreamFn(steps)
    const ticks: any[] = []
    const episodes: any[] = []

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        computeDelayMs: () => 0,
        sleep: async () => {},
        providerBackoff: { computeDelayMs: () => 0, sleep: async () => {}, now: () => 0 },
      },
      onProviderBackoff: (info) => ticks.push(info),
      onRetryEpisodeEnd: (s) => episodes.push(s),
    })

    expect(result.text).toBe('finally')
    expect(ticks.map((t) => t.suspectedDeterministic)).toEqual([false, false, false, false, false, true, true, true])
    expect(episodes).toEqual([
      expect.objectContaining({ outcome: 'recovered', layer: 'provider_backoff', attempts: 9, suspectedDeterministic: true }),
    ])
  })

  test('provider backoff: waker cuts the backoff sleep short (Retry now)', async () => {
    const { fn, getCalls } = createScriptedStreamFn([
      { throw: '529 overloaded_error: Overloaded' },
      { throw: '529 overloaded_error: Overloaded' },
      buildTextResponse('back'),
    ])
    const waker = new RetryWaker()
    const started = Date.now()

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        computeDelayMs: () => 0,
        sleep: async () => {},
        waker,
        // Real abortable sleep with a 60s delay; only the waker lets this finish quickly.
        providerBackoff: { computeDelayMs: () => 60_000 },
      },
      onProviderBackoff: () => setTimeout(() => waker.wake(), 5),
    })

    expect(result.text).toBe('back')
    expect(getCalls()).toBe(3)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('provider backoff: truncation is not retried beyond the fast budget', async () => {
    const { fn, getCalls } = createScriptedStreamFn([{ throw: 'Anthropic stream ended before message_stop' }])
    const clock = fakeBackoffClock()

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: {
        maxAttempts: 1,
        computeDelayMs: () => 0,
        sleep: async () => {},
        providerBackoff: { maxWaitMs: 180_000, sleep: clock.sleep, now: clock.now },
      },
    })

    expect(result.error).toBeDefined()
    expect(getCalls()).toBe(2)
    expect(clock.sleeps).toEqual([])
  })

  test('retry can be disabled via inferenceRetry: false', async () => {
    const { fn, getCalls } = createScriptedStreamFn([
      { throw: 'socket hang up' },
      buildTextResponse('would-be recovery'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: fn,
      inferenceRetry: false,
    })

    expect(getCalls()).toBe(1) // no retry attempted
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

    await gateway.processChatMessageStream('Hello', mockWriter as any, {
      chatSessionId: 'error-recovery-zero-output',
    })

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
    const sessionId = 'error-recovery-persists-user'
    await gateway.processChatMessageStream('Hello', mockWriter as any, {
      chatSessionId: sessionId,
    })

    const session = gateway.getSessionManager().get(sessionId)
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
