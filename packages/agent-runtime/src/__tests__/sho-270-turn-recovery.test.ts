// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-270 — a failed turn ends with its own recovery, never with a raw provider
 * error. Two of the production buckets end-to-end through the gateway with a
 * mocked provider (no paid calls):
 *
 *   1. out of credit  -> the usage-limit notice + Upgrade prompt
 *   2. a refusal      -> one cross-family failover with `data-routing-fallback`
 *
 * Run: bun test packages/agent-runtime/src/__tests__/sho-270-turn-recovery.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import {
  createAssistantMessageEventStream,
  createAssistantMessageEventStream as _s,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@mariozechner/pi-ai'
import { AgentGateway, selectCrossFamilyFallback } from '../gateway'
import { __setAvailableModelsForTests, __resetAvailableModelsForTests } from '../available-models'
import { classifyTurnFailure, isFailoverFailure } from '../agent-loop'

const TEST_DIR = join(import.meta.dir, '.tmp-sho-270-recovery')
let gateway: AgentGateway | undefined

const usage = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function textResponse(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock-model',
    usage,
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function errorResponse(message: string, stopReason: 'error' | 'refusal' = 'error'): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock-model',
    usage: { ...usage, output: 0 },
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  } as AssistantMessage
}

/** Answer differently per model, so a failover is observable. */
function scriptedByModel(handlers: Record<string, () => AssistantMessage>): StreamFn {
  const entries = Object.entries(handlers)
  return ((model: any) => {
    const stream = createAssistantMessageEventStream()
    const id = String(model?.id ?? model?.apiModel ?? '')
    const make = entries.find(([key]) => id.includes(key))?.[1] ?? entries[0][1]
    queueMicrotask(() => {
      const message = make()
      stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
      // Text has to arrive as deltas: the loop forwards `text_delta` events to
      // the gateway, and a `done`-only stream reaches the client as silence.
      message.content.forEach((block, contentIndex) => {
        if (block.type !== 'text') return
        stream.push({ type: 'text_start', contentIndex, partial: message } as AssistantMessageEvent)
        stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: message } as AssistantMessageEvent)
        stream.push({
          type: 'text_end', contentIndex, content: block.text, partial: message,
        } as AssistantMessageEvent)
      })
      const stopReason: string = message.stopReason
      const reason = stopReason === 'toolUse' ? 'toolUse' : stopReason === 'error' || stopReason === 'refusal' ? 'error' : 'stop'
      stream.push({ type: 'done', reason, message } as AssistantMessageEvent)
      stream.end(message)
    })
    return stream
  }) as StreamFn
}

function collect() {
  const chunks: any[] = []
  return { chunks, writer: { write: (c: any) => chunks.push(c) } }
}

function textOf(chunks: any[]): string {
  return chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => String(c.delta ?? ''))
    .join('')
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  __resetAvailableModelsForTests()
  __setAvailableModelsForTests([
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet', provider: 'anthropic' },
    { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', provider: 'openai' },
  ])
})

afterEach(() => {
  __resetAvailableModelsForTests()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('classifier → recovery decisions', () => {
  test('a refusal is failover-eligible; a usage limit is not', () => {
    expect(isFailoverFailure(classifyTurnFailure({ rawError: 'Model refused this request (stop_reason=refusal)' }))).toBe(true)
    expect(isFailoverFailure(classifyTurnFailure({ rawError: "402 You've reached your usage limit" }))).toBe(false)
  })

  test('the cross-family pick never lands on the failing provider', () => {
    const picked = selectCrossFamilyFallback({
      failedModel: 'claude-sonnet-4-6',
      failedProvider: 'anthropic',
    })
    expect(picked).not.toBeNull()
    expect(picked!.provider).toBe('openai')
    expect(picked!.model).not.toBe('claude-sonnet-4-6')
  })

  test('nothing to fail over to returns null instead of guessing', () => {
    __setAvailableModelsForTests([{ id: 'claude-haiku-4-5-20251001', displayName: 'Haiku', provider: 'anthropic' }])
    expect(
      selectCrossFamilyFallback({ failedModel: 'claude-sonnet-4-6', failedProvider: 'anthropic' }),
    ).toBeNull()
  })
})

describe('out of credit ends in the usage-limit notice', () => {
  test('an OpenAI-compatible "reached your usage limit" shows the Upgrade prompt', async () => {
    gateway = new AgentGateway(TEST_DIR, 'sho-270-usage')
    gateway.setStreamFn(scriptedByModel({
      'claude-sonnet-4-6': () => errorResponse("402 You've reached your usage limit. Please check your plan and billing details."),
      'gpt-5.4-mini': () => textResponse('should not be reached'),
    }))
    await gateway.start()

    const { chunks, writer } = collect()
    await gateway.processChatMessageStream('build me a dashboard', writer as any, {
      chatSessionId: 'sho-270-usage',
      modelOverride: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
    })

    const text = textOf(chunks)
    expect(text).toContain("You've reached your usage limit")
    expect(text).toContain('Settings > Billing')
    // The raw provider text and the old fallback sentence are gone for good.
    expect(text).not.toContain('recoverable provider error')
    expect(text).not.toContain('402 ')
  })
})

describe('a refusal fails over once to another provider family', () => {
  test('the turn re-runs on the other family and the switch is visible', async () => {
    gateway = new AgentGateway(TEST_DIR, 'sho-270-refusal')
    gateway.setStreamFn(scriptedByModel({
      'claude-sonnet-4-6': () => errorResponse('Model refused this request (stop_reason=refusal)'),
      'gpt-5.4-mini': () => textResponse('Here is the answer from the other family.'),
    }))
    await gateway.start()

    const { chunks, writer } = collect()
    const result = await gateway.processChatMessageStream('summarise this thread', writer as any, {
      chatSessionId: 'sho-270-refusal',
      modelOverride: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
    })

    const fallbackEvent = chunks.find((c) => c.type === 'data-routing-fallback')
    expect(fallbackEvent).toBeDefined()
    expect(fallbackEvent.data.fromModel).toBe('claude-sonnet-4-6')
    expect(fallbackEvent.data.toModel).toBe('gpt-5.4-mini')
    expect(fallbackEvent.data.reason).toBe('refusal')

    expect(textOf(chunks)).toContain('Here is the answer from the other family.')
    expect(textOf(chunks)).not.toContain('recoverable provider error')
    expect(textOf(chunks)).not.toContain('stop_reason')

    // The switch is one turn only: the session keeps the model the person chose.
    const session = gateway.getSessionManager().get('sho-270-refusal')
    expect(session?.modelOverride ?? null).not.toBe('gpt-5.4-mini')
  })

  test('with no other family available the turn says so plainly, with no raw error', async () => {
    __setAvailableModelsForTests([{ id: 'claude-haiku-4-5-20251001', displayName: 'Haiku', provider: 'anthropic' }])
    gateway = new AgentGateway(TEST_DIR, 'sho-270-refusal-none')
    gateway.setStreamFn(scriptedByModel({
      'claude-sonnet-4-6': () => errorResponse('Model refused this request (stop_reason=refusal)'),
    }))
    await gateway.start()

    const { chunks, writer } = collect()
    await gateway.processChatMessageStream('summarise this thread', writer as any, {
      chatSessionId: 'sho-270-refusal-none',
      modelOverride: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
    })

    const errorChunk = chunks.find((c) => c.type === 'error')
    const text = textOf(chunks)
    expect(errorChunk?.errorText ?? text).toContain('declined')
    expect(text + (errorChunk?.errorText ?? '')).not.toContain('recoverable provider error')
    expect(text + (errorChunk?.errorText ?? '')).not.toContain('An unknown error occurred')
  })
})
