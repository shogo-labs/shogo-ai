// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy — streamed usage is recorded once, on every exit (SHO-599).
 *
 * Every streaming path used to record only in the `TransformStream`'s
 * `flush()`, which never runs when the client cancels (Stop), the idle
 * watchdog tears the stream down, or the upstream faults mid-body. Anthropic
 * bills the input and cache tokens the moment `message_start` arrives, so a
 * cancelled call left real spend with no `usage_events` row — the $5,126 gap
 * in the Oct 28 – Nov 26 Anthropic bill.
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-proxy-stream-usage.test.ts
 */

import { describe, test, expect, afterEach, mock } from 'bun:test'
import {
  proxyAnthropicStream,
  proxyOpenAIStream,
  proxySseWithEarlyHeaders,
  convertOpenAIStreamToAnthropicStream,
  createStreamUsageMeter,
  estimateTokensFromChars,
  type ChatCompletionRequest,
  type ModelConfig,
  type StreamUsageOutcome,
  type StreamUsageTotals,
  type StreamRecordOptions,
} from '../ai-proxy'

const TE = new TextEncoder()
const TD = new TextDecoder()

function sseStreamFrom(
  chunks: string[],
  opts: { errorAfter?: number; delayMsBetween?: number } = {},
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i > 0 && opts.delayMsBetween) {
        await new Promise((r) => setTimeout(r, opts.delayMsBetween))
      }
      if (opts.errorAfter !== undefined && i === opts.errorAfter) {
        controller.error(new TypeError('fetch failed'))
        return
      }
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(TE.encode(chunks[i]!))
      i++
    },
  })
}

/** An upstream SSE response whose chunks arrive slowly enough to cancel mid-way. */
function streamedFetch(chunks: string[], opts: { errorAfter?: number; delayMsBetween?: number } = {}) {
  ;(globalThis as any).fetch = mock(async () => new Response(sseStreamFrom(chunks, opts), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }))
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += TD.decode(value, { stream: true })
  }
  return out
}

function scriptFetch(body: string, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = mock(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } })
  })
  ;(globalThis as any).fetch = fn
  return { fn, calls }
}

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

// ──────────────────────────────────────────────────────────────────────────────
// The meter
// ──────────────────────────────────────────────────────────────────────────────

describe('createStreamUsageMeter', () => {
  type Call = { usage: StreamUsageTotals; outcome: StreamUsageOutcome; estimated: boolean }

  test('records once even when flush and a later cancel both settle', () => {
    const calls: Call[] = []
    const meter = createStreamUsageMeter((usage, outcome, estimated) => {
      calls.push({ usage, outcome, estimated })
    })
    meter.note({ inputTokens: 10, outputTokens: 4 })
    meter.settle('complete')
    meter.settle('cancelled')
    expect(calls).toHaveLength(1)
    expect(calls[0].outcome).toBe('complete')
    expect(calls[0].estimated).toBe(false)
  })

  test('estimates input from the request and output from the text when nothing arrived', () => {
    const calls: Call[] = []
    const meter = createStreamUsageMeter(
      (usage, outcome, estimated) => calls.push({ usage, outcome, estimated }),
      { estimatedInputTokens: 250 },
    )
    meter.noteOutputChars(40)
    meter.settle('cancelled')
    expect(calls).toHaveLength(1)
    expect(calls[0].usage.inputTokens).toBe(250)
    expect(calls[0].usage.outputTokens).toBe(10)
    expect(calls[0].outcome).toBe('cancelled')
    expect(calls[0].estimated).toBe(true)
  })

  test('estimates only the output when the provider reported the input', () => {
    const calls: Call[] = []
    const meter = createStreamUsageMeter((usage, outcome, estimated) => {
      calls.push({ usage, outcome, estimated })
    })
    meter.note({ inputTokens: 12, cachedInputTokens: 3 })
    meter.noteOutputChars(11)
    meter.settle('cancelled')
    expect(calls[0].usage.inputTokens).toBe(12)
    expect(calls[0].usage.cachedInputTokens).toBe(3)
    expect(calls[0].usage.outputTokens).toBe(3)
    expect(calls[0].estimated).toBe(true)
  })

  test('records nothing for a call that produced no tokens at all', () => {
    let settled = 0
    const meter = createStreamUsageMeter(() => { settled++ })
    meter.settle('cancelled')
    expect(settled).toBe(0)
  })

  test('estimateTokensFromChars rounds up and never goes negative', () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(-5)).toBe(0)
    expect(estimateTokensFromChars(1)).toBe(1)
    expect(estimateTokensFromChars(41)).toBe(11)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// proxyAnthropicStream (chat-completions path, Anthropic upstream)
// ──────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_SSE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n' +
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n\n'

const chatRequest: ChatCompletionRequest = {
  model: 'claude-opus-4-8',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
}
const anthropicConfig: ModelConfig = {
  provider: 'anthropic',
  apiModel: 'claude-opus-4-8',
  displayName: 'Claude Opus 4.8',
}

describe('proxyAnthropicStream records once on every exit', () => {
  test('a normal completion records the real usage with no cancel flag', async () => {
    scriptFetch(ANTHROPIC_SSE)
    const calls: any[][] = []
    const res = await proxyAnthropicStream(chatRequest, 'k', anthropicConfig, (...args) => calls.push(args))
    await collect(res.body!)

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(12)
    expect(calls[0][1]).toBe(7)
    expect(calls[0][2]).toBe(3)
    expect(calls[0][3]).toBe(2)
    expect(calls[0][4]).toBeUndefined()
  })

  test('a stream the client cancels after message_start records its input and cache tokens', async () => {
    // Only `message_start` has arrived when the client cancels: the cumulative
    // output tokens Anthropic reports on `message_delta` never do. (The output
    // estimate itself is pinned deterministically in the meter tests above.)
    const frames = ANTHROPIC_SSE.split('\n\n')
    streamedFetch([frames[0] + '\n\n', frames.slice(1).join('\n\n')], { delayMsBetween: 60 })
    const calls: any[][] = []
    const res = await proxyAnthropicStream(chatRequest, 'k', anthropicConfig, (...args) => calls.push(args))

    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(12)
    expect(calls[0][2]).toBe(3)
    expect(calls[0][3]).toBe(2)
    const options = calls[0][4] as StreamRecordOptions
    expect(options.streamOutcome).toBe('cancelled')
    // The tokens Anthropic had already billed are on the row even though the
    // stream never closed.
    expect(calls[0][0]).toBe(12)
    expect(calls[0][2]).toBe(3)
    expect(calls[0][3]).toBe(2)
  })

  test('an upstream that faults mid-stream still records once', async () => {
    const fn = mock(async () => {
      return new Response(sseStreamFrom([ANTHROPIC_SSE.split('\n\n')[0] + '\n\n'], { errorAfter: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }) as any
    })
    ;(globalThis as any).fetch = fn

    const calls: any[][] = []
    const res = await proxyAnthropicStream(chatRequest, 'k', anthropicConfig, (...args) => calls.push(args))
    await collect(res.body!)
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(12)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// proxyOpenAIStream (OpenAI-compatible, Gemini compat, native video)
// ──────────────────────────────────────────────────────────────────────────────

const OPENAI_SSE =
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25,"prompt_tokens_details":{"cached_tokens":4}}}\n\n' +
  'data: [DONE]\n\n'

const openAIConfig: ModelConfig = {
  provider: 'openai',
  apiModel: 'gpt-5.4-nano',
  displayName: 'GPT-5.4 nano',
}

describe('proxyOpenAIStream records once on every exit', () => {
  test('a normal completion records the usage chunk exactly once', async () => {
    scriptFetch(OPENAI_SSE)
    const calls: any[][] = []
    const res = await proxyOpenAIStream(chatRequest, 'k', openAIConfig, (...args) => calls.push(args))
    await collect(res.body!)

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(16) // prompt 20 − cached 4
    expect(calls[0][1]).toBe(5)
    expect(calls[0][2]).toBe(4)
    expect(calls[0][5]).toBeUndefined()
  })

  test('a cancelled stream records the text seen so far, flagged as an estimate', async () => {
    // First content chunk only: the `include_usage` chunk never arrives.
    const lines = OPENAI_SSE.split('\n\n')
    streamedFetch([lines[0] + '\n\n', lines.slice(1).join('\n\n')], { delayMsBetween: 60 })
    const calls: any[][] = []
    const res = await proxyOpenAIStream(chatRequest, 'k', openAIConfig, (...args) => calls.push(args))

    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toHaveLength(1)
    const options = calls[0][5] as StreamRecordOptions
    expect(options.streamOutcome).toBe('cancelled')
    expect(options.usageEstimated).toBe(true)
    // "Hello" streamed → ceil(5/4).
    expect(calls[0][1]).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// proxySseWithEarlyHeaders — the terminal hook every path relies on
// ──────────────────────────────────────────────────────────────────────────────

describe('proxySseWithEarlyHeaders onStreamEnd', () => {
  test('fires once with "complete" on a clean end', async () => {
    scriptFetch('data: one\n\ndata: two\n\n')
    const outcomes: StreamUsageOutcome[] = []
    const res = await proxySseWithEarlyHeaders(
      () => fetch('https://example.test/sse'),
      { providerLabel: 'test', onStreamEnd: (o) => outcomes.push(o) },
    )
    await collect(res.body!)
    expect(outcomes).toEqual(['complete'])
  })

  test('fires once with "cancelled" when the client cancels', async () => {
    scriptFetch('data: one\n\ndata: two\n\n')
    const outcomes: StreamUsageOutcome[] = []
    const res = await proxySseWithEarlyHeaders(
      () => fetch('https://example.test/sse'),
      { providerLabel: 'test', onStreamEnd: (o) => outcomes.push(o) },
    )
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 10))
    expect(outcomes).toEqual(['cancelled'])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// OpenAI on /anthropic/v1/messages — the conversion had no usage hook at all
// ──────────────────────────────────────────────────────────────────────────────

describe('convertOpenAIStreamToAnthropicStream usage', () => {
  test('reports the usage chunk and the streamed character count', async () => {
    const usage: Array<Partial<StreamUsageTotals>> = []
    let chars = 0
    const converted = convertOpenAIStreamToAnthropicStream(
      sseStreamFrom([OPENAI_SSE]),
      'gpt-5.4-nano',
      (u) => usage.push(u),
      (c) => { chars += c },
    )
    await collect(converted)

    expect(usage).toHaveLength(1)
    expect(usage[0].inputTokens).toBe(16)
    expect(usage[0].cachedInputTokens).toBe(4)
    expect(usage[0].outputTokens).toBe(5)
    expect(chars).toBe('Hello world'.length)
  })
})
