// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A usage limit (the AI proxy's 402) must reach the client as
 * `data-usage-limit`, which ChatPanel turns into the Upgrade / Continue
 * panel. Before, a limit hit on the first model call of a turn surfaced as a
 * plain error with no way to upgrade.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage } from '@mariozechner/pi-ai'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'

const TEST_DIR = '/tmp/test-gateway-usage-limit'
const LIMIT_402 =
  '402 {"error":{"message":"Usage limit reached. Enable usage-based pricing or upgrade your plan.",' +
  '"type":"billing_error","code":"usage_limit_reached","resetsAt":"2099-01-01T00:00:00.000Z","window":"5h"}}'

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

/** pi-ai's provider catch: the HTTP error becomes `errorMessage` on an error stream. */
function providerErrorStream(errorMessage: string) {
  const output = {
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

describe('gateway: usage limit reaches the client as data-usage-limit', () => {
  let gateway: AgentGateway | undefined
  const prevProviderRetry = process.env.SHOGO_PROVIDER_RETRY

  beforeEach(() => {
    setupWorkspace()
    process.env.SHOGO_PROVIDER_RETRY = 'off'
  })

  afterEach(async () => {
    if (prevProviderRetry === undefined) delete process.env.SHOGO_PROVIDER_RETRY
    else process.env.SHOGO_PROVIDER_RETRY = prevProviderRetry
    if (gateway) await gateway.stop()
    gateway = undefined
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('a limit on the first model call shows the limit notice and no error', async () => {
    let calls = 0
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(() => {
      calls++
      return providerErrorStream(LIMIT_402)
    })
    await gateway.start()

    const chunks: any[] = []
    await gateway.processChatMessageStream('build me a landing page', { write: (c: any) => { chunks.push(c) } } as any, {
      chatSessionId: 'limit-first-call',
    })

    expect(calls).toBe(1)
    expect(chunks.filter((c) => c.type === 'error')).toEqual([])
    const limit = chunks.find((c) => c.type === 'data-usage-limit')
    expect(limit?.data).toMatchObject({ resetsAt: '2099-01-01T00:00:00.000Z', window: '5h', toolCallCount: 0 })
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')
    expect(text).toContain("You've reached your usage limit")
  })
})
