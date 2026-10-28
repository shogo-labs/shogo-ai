// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Production digests (Oct 13-15) repeatedly reported turns ending in
 * "Sorry, I was unable to generate a response. Please try again." even though
 * the user's retry usually worked. The gateway now retries a turn once when it
 * produced nothing at all, before anything is persisted or streamed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'

const EMPTY_FALLBACK = 'Sorry, I was unable to generate a response. Please try again.'
const TEST_DIR = '/tmp/test-gateway-empty-response-retry'

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

function assistantStream(content: any[], outputTokens: number, extra: Partial<AssistantMessage> = {}) {
  const msg = {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { ...ZERO_USAGE, output: outputTokens, totalTokens: outputTokens },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...extra,
  } as AssistantMessage
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    msg.content.forEach((block: any, contentIndex) => {
      if (block.type !== 'text') return
      stream.push({ type: 'text_start', contentIndex, partial: msg } as any)
      stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: msg } as any)
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: msg } as any)
    })
    if (msg.stopReason === 'error') {
      stream.push({ type: 'error', reason: 'error', error: msg } as any)
      stream.end()
    } else {
      stream.push({ type: 'done', reason: 'stop', message: msg } as any)
      stream.end(msg)
    }
  })
  return stream as any
}

/** The model spends its output on hidden reasoning and never writes an answer. */
const reasoningOnly = () => assistantStream([{ type: 'thinking', thinking: 'Let me think about this...' }], 40)
/** The provider closes the stream without producing anything. */
const nothing = () => assistantStream([], 0)
const answer = (text: string) => assistantStream([{ type: 'text', text }], 5)

function scripted(steps: Array<() => any>, calls: { n: number }): StreamFn {
  return () => {
    const step = steps[Math.min(calls.n, steps.length - 1)]
    calls.n++
    return step()
  }
}

async function send(gateway: AgentGateway, sessionId: string, text: string) {
  const chunks: any[] = []
  await gateway.processChatMessageStream(text, { write: (c: any) => { chunks.push(c) } } as any, {
    chatSessionId: sessionId,
  })
  return chunks
}

function streamedText(chunks: any[]): string {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')
}

function userMessages(gateway: AgentGateway, sessionId: string, text: string) {
  return gateway.getSessionManager().get(sessionId)!.messages.filter(
    (m: any) => m.role === 'user' && JSON.stringify(m.content).includes(text),
  )
}

describe('gateway: auto-retry an empty turn once', () => {
  let gateway: AgentGateway | undefined
  const prevRetryBase = process.env.SHOGO_INFERENCE_RETRY_BASE_MS
  const prevProviderRetry = process.env.SHOGO_PROVIDER_RETRY

  beforeEach(() => {
    setupWorkspace()
    process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
    process.env.SHOGO_PROVIDER_RETRY = 'off'
  })

  afterEach(async () => {
    if (prevRetryBase === undefined) delete process.env.SHOGO_INFERENCE_RETRY_BASE_MS
    else process.env.SHOGO_INFERENCE_RETRY_BASE_MS = prevRetryBase
    if (prevProviderRetry === undefined) delete process.env.SHOGO_PROVIDER_RETRY
    else process.env.SHOGO_PROVIDER_RETRY = prevProviderRetry
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('reasoning-only turn (and its in-loop finalizer) is retried and the answer reaches the user', async () => {
    const calls = { n: 0 }
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    // First loop: the turn and the loop's own finalizer both come back empty.
    gateway.setStreamFn(scripted([reasoningOnly, reasoningOnly, () => answer('Here is your answer.')], calls))
    await gateway.start()

    const chunks = await send(gateway, 'reasoning-only', 'summarize my project')
    const text = streamedText(chunks)
    expect(text).toContain('Here is your answer.')
    expect(text).not.toContain(EMPTY_FALLBACK)
    expect(chunks.filter((c) => c.type === 'error')).toEqual([])
    expect(userMessages(gateway, 'reasoning-only', 'summarize my project')).toHaveLength(1)
  })

  test('a provider that returns nothing is retried once', async () => {
    const calls = { n: 0 }
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(scripted([nothing, () => answer('Recovered.')], calls))
    await gateway.start()

    const chunks = await send(gateway, 'nothing-once', 'hello')
    expect(streamedText(chunks)).toContain('Recovered.')
    expect(chunks.filter((c) => c.type === 'error')).toEqual([])
    expect(userMessages(gateway, 'nothing-once', 'hello')).toHaveLength(1)
  })

  test('retries only once: a persistently empty model still gets the fallback', async () => {
    const calls = { n: 0 }
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(scripted([reasoningOnly], calls))
    await gateway.start()

    const chunks = await send(gateway, 'always-empty', 'hello')
    expect(streamedText(chunks)).toContain(EMPTY_FALLBACK)
    // Two loops, each the turn plus its finalizer.
    expect(calls.n).toBe(4)
    expect(userMessages(gateway, 'always-empty', 'hello')).toHaveLength(1)
  })

  test('a non-retryable provider error is not retried', async () => {
    const calls = { n: 0 }
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(scripted([
      () => assistantStream([], 0, {
        stopReason: 'error',
        errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: roles must alternate between \\"user\\" and \\"assistant\\""}}',
      } as any),
    ], calls))
    await gateway.start()

    await send(gateway, 'bad-request', 'hello')
    expect(calls.n).toBe(1)
  })
})
