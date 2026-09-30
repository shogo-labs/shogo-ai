// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRO — Sentry JAVASCRIPT-REACT-45 (web) / SHOGO-DESKTOP-F (desktop):
 *   client receives UI-stream `{ type: 'error', errorText:
 *   'I encountered an issue processing your message. Please try again.' }`
 *
 * That exact text is ONLY produced by the `result.error` branch of
 * `_agentTurnInner` (gateway.ts ~3645) via `describeTurnFailure(msg)` with the
 * default `unknownFallback` — i.e. `classifyRetryability` bucketed the raw
 * error as `invalid_request` or `unknown`. The raw cause is logged server-side
 * only as `[AgentGateway] Agent error for session <id>: <raw>` and never
 * reaches Sentry.
 *
 * Breadcrumbs (latest web event): a long turn (>10 min, two AutoResume EOF
 * reconnects), then every new send in the same session fails ~4s after
 * POST /api/chat-messages. That is a *sticky* per-session failure with no
 * retries — the signature of a non-retryable 400 caused by session state.
 *
 * Scenario 1 (sticky, primary) is FIXED: after a long tool-heavy turn the
 * session's real payload exceeded the model context window, but
 * `SessionManager.estimateTokens` only counted `text` blocks and ignored
 * assistant `toolCall.arguments` (write_file/edit_file bodies), so pre-turn
 * autocompact (Layer 4) never fired; and because pi-ai reports
 * `400 ... prompt is too long` as an `errorMessage` rather than throwing,
 * reactive compaction (Layer 5) never ran either. Every send hit the same
 * wall. The estimator now counts tool-call arguments and images, and the
 * agent loop runs reactive compaction for error-message overflows too.
 *
 * SigNoz later showed the breadcrumb session itself (1691b02a) failed on a
 * different sticky 400: `.messages[113].image[0]: You have uploaded an
 * unsupported image`. Scenario 1 is a separate latent path to the same text.
 *
 * Scenarios 2 and 3 (transient) are FIXED and now assert the corrected
 * behavior: `network_drop` maps to `network`, and a retry give-up keeps the
 * real error text, so both surface the "connection dropped" copy.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/turn-failure-generic-fallback.repro.test.ts
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage, Message, ToolResultMessage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway, describeTurnFailure } from '../gateway'
import { classifyRetryability } from '../agent-loop'

const GENERIC = 'I encountered an issue processing your message. Please try again.'
const CONNECTION_DROPPED = "I couldn't reach the model just now — the connection dropped. Please try again in a moment."
const TEST_DIR = '/tmp/test-turn-failure-generic-fallback-repro'
const MODEL_CONTEXT_LIMIT = 200_000

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true })
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
    }),
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Agent\nYou are a test agent.')
}

/**
 * Mirrors pi-ai's anthropic provider catch block (providers/anthropic.js
 * ~509-518): the SDK error message becomes `errorMessage`, stopReason 'error',
 * an `error` event is pushed, and the stream ends. Nothing is thrown.
 */
function providerErrorStream(errorMessage: string) {
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: ZERO_USAGE,
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  } as AssistantMessage
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: output } as any)
    stream.push({ type: 'error', reason: 'error', error: output } as any)
    stream.end()
  })
  return stream as any
}

function okStream(text: string) {
  const msg = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { ...ZERO_USAGE, output: 5, totalTokens: 5 },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    stream.push({ type: 'done', reason: 'stop', message: msg } as any)
    stream.end(msg)
  })
  return stream as any
}

/**
 * Fake Anthropic endpoint: rejects with the real 400 body when the serialized
 * request (system + messages, incl. tool-call arguments) exceeds `limit`,
 * otherwise answers normally.
 */
function anthropicWithContextLimit(calls: { tokens: number }[], limit = MODEL_CONTEXT_LIMIT): StreamFn {
  return (_model, context) => {
    const tokens = Math.ceil(
      JSON.stringify({ system: context.systemPrompt, messages: context.messages }).length / 4,
    )
    calls.push({ tokens })
    if (tokens > limit) {
      return providerErrorStream(
        `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: ${tokens} tokens > ${limit} maximum"},"request_id":"req_repro"}`,
      )
    }
    return okStream('Upload looks good.')
  }
}

/** History left behind by a long, tool-heavy (interrupted) turn: many large writes. */
function longToolHeavyTurn(writes: number, bytesPerWrite: number): Message[] {
  const msgs: Message[] = [
    { role: 'user', content: 'Build the file upload app end to end.', timestamp: Date.now() } as Message,
  ]
  const body = 'x'.repeat(bytesPerWrite)
  for (let i = 0; i < writes; i++) {
    const id = `toolu_write_${i}`
    msgs.push({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'write_file', arguments: { path: `src/f${i}.tsx`, content: body } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: ZERO_USAGE,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as AssistantMessage)
    msgs.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'write_file',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: Date.now(),
    } as ToolResultMessage)
  }
  return msgs
}

async function send(gateway: AgentGateway, sessionId: string, text: string) {
  const chunks: any[] = []
  await gateway.processChatMessageStream(text, { write: (c: any) => { chunks.push(c) } } as any, {
    chatSessionId: sessionId,
  })
  return chunks
}

describe('REPRO JAVASCRIPT-REACT-45 / SHOGO-DESKTOP-F: raw turn failure swallowed into generic fallback', () => {
  let gateway: AgentGateway | undefined
  let errSpy: ReturnType<typeof spyOn>
  const prevRetryBase = process.env.SHOGO_INFERENCE_RETRY_BASE_MS
  const prevProviderRetry = process.env.SHOGO_PROVIDER_RETRY

  beforeEach(() => {
    setupWorkspace()
    errSpy = spyOn(console, 'error')
    process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
    // Exercise the give-up path without the unlimited provider backoff.
    process.env.SHOGO_PROVIDER_RETRY = 'off'
  })

  afterEach(async () => {
    errSpy.mockRestore()
    if (prevRetryBase === undefined) delete process.env.SHOGO_INFERENCE_RETRY_BASE_MS
    else process.env.SHOGO_INFERENCE_RETRY_BASE_MS = prevRetryBase
    if (prevProviderRetry === undefined) delete process.env.SHOGO_PROVIDER_RETRY
    else process.env.SHOGO_PROVIDER_RETRY = prevProviderRetry
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('scenario 1a (fixed): estimateTokens counts tool-call arguments, so pre-turn autocompact fires', async () => {
    const calls: { tokens: number }[] = []
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(anthropicWithContextLimit(calls))
    await gateway.start()

    const sessionId = '1691b02a-824d-4e8c-a552-341bb31d6f5c'
    const sm = gateway.getSessionManager()
    sm.addMessages(sessionId, ...longToolHeavyTurn(60, 16_000))
    expect(sm.needsCompaction(sm.get(sessionId)!)).toBe(true)

    for (const text of ['can you check the upload?', 'hello?']) {
      const chunks = await send(gateway, sessionId, text)
      expect(chunks.filter((c) => c.type === 'error')).toEqual([])
    }
    expect(sm.get(sessionId)!.compactionCount).toBeGreaterThanOrEqual(1)
    expect(calls.at(-1)!.tokens).toBeLessThanOrEqual(MODEL_CONTEXT_LIMIT)
  })

  test('scenario 1b (fixed): a provider-reported overflow (error message, not a throw) triggers reactive compaction', async () => {
    const calls: { tokens: number }[] = []
    // History the estimator considers fine, but this model's window is smaller.
    const limit = 30_000
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(anthropicWithContextLimit(calls, limit))
    await gateway.start()

    const sessionId = 'reactive-overflow'
    const sm = gateway.getSessionManager()
    sm.addMessages(sessionId, ...longToolHeavyTurn(10, 16_000))
    expect(sm.needsCompaction(sm.get(sessionId)!)).toBe(false)

    const chunks = await send(gateway, sessionId, 'can you check the upload?')
    expect(chunks.filter((c) => c.type === 'error')).toEqual([])
    expect(calls[0].tokens).toBeGreaterThan(limit)
    expect(calls.at(-1)!.tokens).toBeLessThanOrEqual(limit)
    expect(sm.get(sessionId)!.compactionCount).toBe(1)
    expect(classifyRetryability({ message: 'Provider error: 400 prompt is too long: 1 tokens > 200000 maximum' }).reason)
      .toBe('invalid_request')
  })

  test('scenario 2 (fixed): proxy stream error code=network_drop surfaces as "connection dropped"', async () => {
    const raw =
      'Upstream connection dropped mid-stream [shogo:retryable=true;code=network_drop]'
    let callCount = 0
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(() => {
      callCount++
      return providerErrorStream(raw)
    })
    await gateway.start()

    const chunks = await send(gateway, 'desktop-ed4b6cb1', 'hi')
    const errors = chunks.filter((c) => c.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].errorText).toBe(CONNECTION_DROPPED)

    expect(callCount).toBeGreaterThan(1)
    expect(classifyRetryability({ message: raw })).toEqual({ retryable: true, reason: 'network' })
  })

  test('scenario 3 (fixed): a retryable error that exhausts inference retry keeps its raw text', async () => {
    expect(describeTurnFailure('Provider error: Connection error.')).toBe(CONNECTION_DROPPED)

    let callCount = 0
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(() => {
      callCount++
      return providerErrorStream('Connection error.')
    })
    await gateway.start()

    const chunks = await send(gateway, 'exhausted-retry', 'hi')
    const errors = chunks.filter((c) => c.type === 'error')
    expect(callCount).toBe(3)
    expect(errors).toHaveLength(1)
    expect(errors[0].errorText).toBe(CONNECTION_DROPPED)

    const logged = errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n')
    expect(logged).toContain('Agent error for session exhausted-retry: Provider error: Connection error.')
    expect(logged).not.toContain('Agent produced no output')
  })

  test('characterize: raw errors that fall into the generic fallback', () => {
    const fallsThrough = [
      // invalid_request bucket (non-retryable 400/422/context-length)
      'Provider error: 400 prompt is too long: 215000 tokens > 200000 maximum',
      'Provider error: 400 messages.5: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01',
      'Provider error: 400 messages.3.content.0: unexpected `tool_use_id` found in `tool_result` blocks',
      'Provider error: 400 messages: text content blocks must be non-empty',
      'Provider error: 400 messages: roles must alternate between "user" and "assistant"',
      'Provider error: 400 This model\'s maximum context length is 128000 tokens',
      'Provider error: 422 Unprocessable Entity',
      'Provider error: 404 model: claude-x not found',
      // unknown bucket
      'Agent produced no output — possible provider error',
      'Provider error: An unknown error occurred',
      'Provider error: Request was aborted',
      'Provider error: x [shogo:retryable=false;code=upstream_error_foo]',
      "Cannot read properties of undefined (reading 'content')",
      'Aborted before prompt',
    ]
    for (const raw of fallsThrough) {
      expect({ raw, out: describeTurnFailure(raw) }).toEqual({ raw, out: GENERIC })
    }
    expect(describeTurnFailure('Provider error: x [shogo:retryable=true;code=network_drop]')).toBe(CONNECTION_DROPPED)
  })
})
