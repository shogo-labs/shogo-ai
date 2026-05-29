// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Behavior contract for the TTFT stall-fallback StreamFn wrapper.
 *
 * Uses a fake base StreamFn so we can deterministically simulate a model that
 * stalls (emits `start` then nothing) versus one that streams promptly.
 */
import { describe, expect, it } from 'bun:test'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
} from '@mariozechner/pi-ai'
import { makeStallFallbackStreamFn, type StallFallbackRule } from '../stall-fallback'

function model(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  } as Model<Api>
}

function msg(modelId: string, text = ''): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions',
    provider: 'openrouter',
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as any,
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
}

/**
 * Fake base StreamFn keyed on `model.id`:
 * - ids containing "slow": emit `start`, then stall forever (until aborted).
 * - everything else: emit start → text_delta("ok") → done immediately.
 * Records every model id it was invoked with.
 */
function makeFakeBase(calls: string[]): StreamFn {
  return ((m: Model<Api>, _ctx: any, opts: any) => {
    calls.push(m.id)
    const s = createAssistantMessageEventStream()
    const stall = m.id.includes('slow')
    if (stall) {
      queueMicrotask(() => s.push({ type: 'start', partial: msg(m.id) } as AssistantMessageEvent))
      const sig: AbortSignal | undefined = opts?.signal
      const onAbort = () => {
        const aborted = { ...msg(m.id), stopReason: 'aborted', errorMessage: 'aborted' } as AssistantMessage
        s.push({ type: 'error', reason: 'aborted', error: aborted } as AssistantMessageEvent)
      }
      if (sig) sig.addEventListener('abort', onAbort, { once: true })
    } else {
      queueMicrotask(() => {
        const m2 = msg(m.id, 'ok')
        s.push({ type: 'start', partial: m2 } as AssistantMessageEvent)
        s.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: m2 } as AssistantMessageEvent)
        s.push({ type: 'done', reason: 'stop', message: m2 } as AssistantMessageEvent)
      })
    }
    return s
  }) as StreamFn
}

const RULE: StallFallbackRule = {
  matchModelId: 'primary/slow',
  matchProvider: 'openrouter',
  // resolveModel strips the `openrouter:` prefix → resolved Model.id = 'fallback/fast'
  fallbackModel: 'openrouter:fallback/fast',
  fallbackProvider: 'openrouter',
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const ev of stream) events.push(ev)
  return events
}

describe('makeStallFallbackStreamFn', () => {
  it('falls back to the configured model when the primary stalls past ttftMs', async () => {
    const calls: string[] = []
    const fallbacks: Array<{ from: string; to: string }> = []
    const wrapped = makeStallFallbackStreamFn(makeFakeBase(calls), {
      rules: [RULE],
      ttftMs: 25,
      onFallback: (i) => fallbacks.push({ from: i.from, to: i.to }),
    })

    const out = wrapped(model('primary/slow'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>
    const events = await drain(out)

    expect(calls).toEqual(['primary/slow', 'fallback/fast'])
    expect(fallbacks).toEqual([{ from: 'primary/slow', to: 'fallback/fast' }])
    // The buffered primary `start` must be discarded; only the fallback's
    // clean stream is forwarded.
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done'])
    const done = events.find((e) => e.type === 'done') as any
    expect(done.message.model).toBe('fallback/fast')
  })

  it('uses the fallback directly for calls within the cooldown window', async () => {
    const calls: string[] = []
    // Long window so the second call is still inside it.
    const wrapped = makeStallFallbackStreamFn(makeFakeBase(calls), {
      rules: [RULE],
      ttftMs: 25,
      fallbackWindowMs: 10_000,
    })

    await drain(wrapped(model('primary/slow'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>)
    // Second call passes the primary again, but we're inside the window so it
    // should route straight to the fallback without re-probing the primary.
    const events = await drain(
      wrapped(model('primary/slow'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>,
    )

    expect(calls).toEqual(['primary/slow', 'fallback/fast', 'fallback/fast'])
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done'])
  })

  it('re-probes the primary on the next call once the cooldown window expires', async () => {
    const calls: string[] = []
    // Tiny window so it expires before the next call.
    const wrapped = makeStallFallbackStreamFn(makeFakeBase(calls), {
      rules: [RULE],
      ttftMs: 20,
      fallbackWindowMs: 30,
    })

    // Call 1: primary stalls → fallback fires (window = 30ms).
    await drain(wrapped(model('primary/slow'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>)
    // Wait out the window.
    await new Promise((r) => setTimeout(r, 60))
    // Call 2: window expired → re-probe primary (which stalls again) → fallback again.
    await drain(wrapped(model('primary/slow'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>)

    // The primary must have been retried after the window (not skipped).
    expect(calls).toEqual(['primary/slow', 'fallback/fast', 'primary/slow', 'fallback/fast'])
  })

  it('returns to the primary after the window when the primary recovers', async () => {
    const calls: string[] = []
    // Base where the SAME model id stalls on the 1st invocation but streams on later ones.
    let primaryInvocations = 0
    const base: StreamFn = ((m: Model<Api>, _ctx: any, opts: any) => {
      calls.push(m.id)
      const s = createAssistantMessageEventStream()
      const isPrimary = m.id === 'primary/flaky'
      const stall = isPrimary && primaryInvocations++ === 0
      if (stall) {
        queueMicrotask(() => s.push({ type: 'start', partial: msg(m.id) } as AssistantMessageEvent))
        opts?.signal?.addEventListener('abort', () => {
          s.push({ type: 'error', reason: 'aborted', error: { ...msg(m.id), stopReason: 'aborted' } as AssistantMessage } as AssistantMessageEvent)
        }, { once: true })
      } else {
        queueMicrotask(() => {
          const m2 = msg(m.id, 'ok')
          s.push({ type: 'start', partial: m2 } as AssistantMessageEvent)
          s.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: m2 } as AssistantMessageEvent)
          s.push({ type: 'done', reason: 'stop', message: m2 } as AssistantMessageEvent)
        })
      }
      return s
    }) as StreamFn
    const wrapped = makeStallFallbackStreamFn(base, {
      rules: [{ ...RULE, matchModelId: 'primary/flaky' }],
      ttftMs: 20,
      fallbackWindowMs: 30,
    })

    await drain(wrapped(model('primary/flaky'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>)
    await new Promise((r) => setTimeout(r, 60))
    const events = await drain(wrapped(model('primary/flaky'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>)

    // After the window, the primary recovered and served the call directly.
    expect(calls).toEqual(['primary/flaky', 'fallback/fast', 'primary/flaky'])
    const done = events.find((e) => e.type === 'done') as any
    expect(done.message.model).toBe('primary/flaky')
  })

  it('does NOT fall back when the primary streams content before ttftMs', async () => {
    const calls: string[] = []
    const wrapped = makeStallFallbackStreamFn(makeFakeBase(calls), {
      // Rule matches a fast-responding model id.
      rules: [{ ...RULE, matchModelId: 'primary/fast' }],
      ttftMs: 25,
    })

    const events = await drain(
      wrapped(model('primary/fast'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>,
    )

    expect(calls).toEqual(['primary/fast'])
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done'])
    const done = events.find((e) => e.type === 'done') as any
    expect(done.message.model).toBe('primary/fast')
  })

  it('passes through models with no matching rule (zero overhead)', async () => {
    const calls: string[] = []
    const wrapped = makeStallFallbackStreamFn(makeFakeBase(calls), { rules: [RULE], ttftMs: 25 })

    const events = await drain(
      wrapped(model('unrelated/model'), { messages: [] } as any, {}) as AsyncIterable<AssistantMessageEvent>,
    )

    expect(calls).toEqual(['unrelated/model'])
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done'])
  })

  it('forwards a user-initiated abort instead of burning a fallback request', async () => {
    const calls: string[] = []
    const wrapped = makeStallFallbackStreamFn(makeFakeBase(calls), { rules: [RULE], ttftMs: 10_000 })
    const ctrl = new AbortController()

    const out = wrapped(model('primary/slow'), { messages: [] } as any, { signal: ctrl.signal }) as AsyncIterable<AssistantMessageEvent>
    // Abort shortly after start, well before the 10s ttft window.
    setTimeout(() => ctrl.abort(), 15)
    const events = await drain(out)

    // No fallback model was invoked.
    expect(calls).toEqual(['primary/slow'])
    const terminal = events[events.length - 1]
    expect(terminal.type).toBe('error')
    expect((terminal as any).error.stopReason).toBe('aborted')
  })
})
