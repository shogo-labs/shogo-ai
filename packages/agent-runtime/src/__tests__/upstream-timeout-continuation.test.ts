// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-529 — the continuation after a provider that never started must tell the
 * model to *split* the oversized call, and the failing call must be sent once.
 *
 * The frame the AI proxy now writes is
 * `[shogo:retryable=true;code=upstream_timeout]`: the provider took no first byte
 * within `EARLY_SSE_MAX_WAIT_MS`. The agent loop treats that code as
 * send-once (see `isFirstByteTimeout`), so the turn ends as `provider_error` and
 * the gateway's bounded auto-continue re-issues it with the split-the-write
 * guidance from SHO-517 instead of the same giant `write_file`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'

const TEST_DIR = '/tmp/test-gateway-upstream-timeout'
const CLOSING_PROMPT_MARKER = 'Write the final response for this turn now'
const CONTINUATION_MARKER = 'Continue —'

const UPSTREAM_TIMEOUT =
  'The model did not start responding within 240s. Split large tool calls (e.g. write_file then append). ' +
  '[shogo:retryable=true;code=upstream_timeout]'

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

function message(content: any[], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { ...ZERO_USAGE, output: 5, totalTokens: 5 },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...extra,
  } as AssistantMessage
}

/** The model spends the whole call on one giant tool call. */
function toolCallStream(name: string, args: Record<string, any>, id = 'call_1') {
  const msg = message([{ type: 'toolCall', id, name, arguments: args }], { stopReason: 'toolUse' })
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: (msg.content as any)[0], partial: msg } as any)
    stream.push({ type: 'done', reason: 'toolUse', message: msg } as any)
  })
  return stream as any
}

function errorStream(errorMessage: string) {
  const msg = message([{ type: 'text', text: '' }], { stopReason: 'error', errorMessage })
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    stream.push({ type: 'done', reason: 'error', message: msg } as any)
  })
  return stream as any
}

function answerStream(text: string) {
  const msg = message([{ type: 'text', text }])
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: msg } as any)
    stream.push({ type: 'text_start', contentIndex: 0, partial: msg } as any)
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: msg } as any)
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: msg } as any)
    stream.push({ type: 'done', reason: 'stop', message: msg } as any)
  })
  return stream as any
}

/** Flatten a prompt message's text, whatever shape pi-ai handed us. */
function promptText(m: any): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
}

async function send(gateway: AgentGateway, sessionId: string, text: string) {
  const chunks: any[] = []
  await gateway.processChatMessageStream(text, { write: (c: any) => { chunks.push(c) } } as any, {
    chatSessionId: sessionId,
  })
  return chunks
}

describe('gateway: a provider that never starts is continued with a reshaped call (SHO-529)', () => {
  let gateway: AgentGateway | undefined
  const prev = {
    retry: process.env.SHOGO_INFERENCE_RETRY,
    base: process.env.SHOGO_INFERENCE_RETRY_BASE_MS,
    providerRetry: process.env.SHOGO_PROVIDER_RETRY,
    probe: process.env.AI_UPSTREAM_HEALTH_URL,
  }

  beforeEach(() => {
    setupWorkspace()
    // Retries ON so "sent once" is a real observation, backoff OFF so a
    // retryable failure cannot park the test in an unlimited ladder.
    process.env.SHOGO_INFERENCE_RETRY = '1'
    process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
    process.env.SHOGO_PROVIDER_RETRY = 'off'
    delete process.env.AI_UPSTREAM_HEALTH_URL
  })

  afterEach(async () => {
    for (const [key, value] of [
      ['SHOGO_INFERENCE_RETRY', prev.retry],
      ['SHOGO_INFERENCE_RETRY_BASE_MS', prev.base],
      ['SHOGO_PROVIDER_RETRY', prev.providerRetry],
      ['AI_UPSTREAM_HEALTH_URL', prev.probe],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('the failing call is sent once and the continuation says to split the write', async () => {
    const prompts: string[] = []
    const state = { primed: false, failing: 0 }

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(((_model: any, ctx: any) => {
      const last = Array.isArray(ctx?.messages) ? ctx.messages[ctx.messages.length - 1] : undefined
      const text = promptText(last)
      if (last?.role === 'user' && (text.includes(CLOSING_PROMPT_MARKER) || text.includes(CONTINUATION_MARKER))) {
        prompts.push(text)
        return answerStream(text.includes(CONTINUATION_MARKER) ? 'Split the write and finished.' : 'Cut off before the giant write.')
      }
      if (!state.primed) {
        state.primed = true
        return toolCallStream('write_file', { path: 'big.py', content: 'print("one giant file")\n' })
      }
      state.failing++
      return errorStream(UPSTREAM_TIMEOUT)
    }) as StreamFn)
    await gateway.start()

    const chunks = await send(gateway, 'first-byte-timeout', 'write the whole generator in one file')

    // One send. A second identical request would spend the whole wait window
    // again and produce the same nothing.
    expect(state.failing).toBe(1)

    const continuation = prompts.filter((p) => p.includes(CONTINUATION_MARKER))
    expect(continuation).toHaveLength(1)
    expect(continuation[0]).toContain('split it: write_file for the first part')
    expect(continuation[0]).toContain('append the rest in chunks')

    const streamed = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')
    expect(streamed).toContain('Split the write and finished.')
  })
})
