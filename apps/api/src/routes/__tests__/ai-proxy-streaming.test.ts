// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy — Streaming Resilience Tests
 *
 * Covers the three invariants that fix "Claude connection lost":
 *
 *   1. Transient 5xx / 429 / 529 / TCP reset before bytes flow is retried
 *      with exponential backoff + jitter and `Retry-After[-Ms]` honored.
 *   2. AbortError caused by the caller's signal NEVER retries — client
 *      cancel must propagate immediately (so the UI's Stop button works).
 *   3. Mid-stream / truncated-EOF Anthropic streams inject an explicit
 *      `event: error` SSE frame so downstream SDKs see a typed error
 *      instead of a silent end-of-stream.
 *   4. A clean `message_stop` stream never injects a synthetic error.
 *   5. SSE keepalive comments are emitted when upstream is idle (keeps
 *      intermediate proxies from killing long Opus thinking windows).
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-proxy-streaming.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  fetchAnthropicWithRetry,
  wrapSseForErrorVisibility,
  scanForTerminalEvent,
  parseRetryAfter,
  isRetryableNetworkError,
  proxyAnthropicStream,
  proxyOpenAIStream,
  proxySseWithEarlyHeaders,
  __setEarlySseTimingForTests,
  type StreamErrorPayload,
  type ChatCompletionRequest,
  type ModelConfig,
} from '../ai-proxy'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const TE = new TextEncoder()
const TD = new TextDecoder()

/** Build a ReadableStream<Uint8Array> from a sequence of string/events. */
function sseStreamFrom(
  chunks: string[],
  opts: { errorAfter?: number; delayMsBetween?: number } = {},
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.delayMsBetween) {
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

/** Patch global fetch with a scriptable sequence of responses. */
function scriptFetch(
  script: Array<Response | Error | (() => Promise<Response> | Response | never)>,
) {
  let call = 0
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const step = script[call++]
    if (step === undefined) {
      throw new Error(`fetch called more than scripted (${call} calls)`)
    }
    if (step instanceof Error) throw step
    if (typeof step === 'function') return await step()
    return step
  })
  ;(globalThis as any).fetch = fn
  return { fn, calls }
}

// ──────────────────────────────────────────────────────────────────────────────
// parseRetryAfter / isRetryableNetworkError (pure helpers)
// ──────────────────────────────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  test('parses integer seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000)
  })
  test('caps at 30s', () => {
    expect(parseRetryAfter('600')).toBe(30_000)
  })
  test('parses HTTP-date', () => {
    const future = new Date(Date.now() + 2000).toUTCString()
    const ms = parseRetryAfter(future)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThanOrEqual(0)
    expect(ms!).toBeLessThanOrEqual(30_000)
  })
  test('returns null for garbage', () => {
    expect(parseRetryAfter('not-a-date')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })
})

describe('isRetryableNetworkError', () => {
  test('detects undici error codes', () => {
    expect(isRetryableNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableNetworkError({ code: 'UND_ERR_SOCKET' })).toBe(true)
    expect(isRetryableNetworkError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
  })
  test('detects "fetch failed" messages', () => {
    expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true)
  })
  test('rejects non-network errors', () => {
    expect(isRetryableNetworkError(new TypeError('bad arg'))).toBe(false)
    expect(isRetryableNetworkError(null)).toBe(false)
  })
})

describe('scanForTerminalEvent (split-frame safe)', () => {
  test('finds message_stop', () => {
    expect(
      scanForTerminalEvent('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    ).toBe(true)
  })
  test('finds error event', () => {
    expect(
      scanForTerminalEvent('data: {"type":"error","error":{"type":"overloaded_error"}}\n\n'),
    ).toBe(true)
  })
  test('ignores text delta that quotes the string', () => {
    expect(
      scanForTerminalEvent(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"type:\\"message_stop\\""}}\n\n',
      ),
    ).toBe(false)
  })
  test('catches message_stop even if split across chunks when buffered', () => {
    // Simulate buffering: previous chunk ended with partial data: line.
    const buffered =
      'data: {"type":"content_block_delta"}\n\ndata: {"type":"mess' +
      'age_stop"}\n\n'
    expect(scanForTerminalEvent(buffered)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// fetchAnthropicWithRetry
// ──────────────────────────────────────────────────────────────────────────────

describe('fetchAnthropicWithRetry', () => {
  const origFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test('returns immediately on 200', async () => {
    const { fn } = scriptFetch([new Response('ok', { status: 200 })])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries on 529 overloaded_error and succeeds on attempt 2', async () => {
    const { fn } = scriptFetch([
      new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
        status: 529,
      }),
      new Response('ok', { status: 200 }),
    ])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('retries on ECONNRESET and succeeds on attempt 2', async () => {
    const err: any = new Error('fetch failed')
    err.code = 'ECONNRESET'
    const { fn } = scriptFetch([err, new Response('ok', { status: 200 })])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('returns final 5xx Response body after maxAttempts', async () => {
    const { fn } = scriptFetch([
      new Response('overloaded 1', { status: 529 }),
      new Response('overloaded 2', { status: 529 }),
    ])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(529)
    expect(await res.text()).toBe('overloaded 2')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('does NOT retry on 400 (client error)', async () => {
    const { fn } = scriptFetch([new Response('bad request', { status: 400 })])
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(res.status).toBe(400)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('does NOT retry on AbortError and bubbles up', async () => {
    const abortErr = new DOMException('Aborted', 'AbortError')
    const { fn } = scriptFetch([abortErr])
    await expect(
      fetchAnthropicWithRetry(
        'https://x',
        { method: 'POST' },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toThrow(/Aborted/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('aborts during backoff sleep', async () => {
    const { fn } = scriptFetch([
      new Response('retry me', { status: 503 }),
      new Response('should not reach', { status: 200 }),
    ])
    const ac = new AbortController()
    const promise = fetchAnthropicWithRetry(
      'https://x',
      { method: 'POST' },
      {
        maxAttempts: 3,
        baseDelayMs: 10_000, // long enough that we must abort during sleep
        maxDelayMs: 10_000,
        signal: ac.signal,
      },
    )
    // Give the first fetch a tick to settle into the backoff sleep.
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    await expect(promise).rejects.toThrow(/Aborted/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('honors Retry-After-Ms header (Anthropic-specific)', async () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'retry-after-ms': '25',
    })
    const { fn } = scriptFetch([
      new Response('slow down', { status: 429, headers }),
      new Response('ok', { status: 200 }),
    ])
    const t0 = Date.now()
    const res = await fetchAnthropicWithRetry('https://x', { method: 'POST' }, {
      maxAttempts: 3,
      baseDelayMs: 10_000, // high base so if we fell back to exp we'd notice
      maxDelayMs: 10_000,
    })
    const elapsed = Date.now() - t0
    expect(res.status).toBe(200)
    expect(fn).toHaveBeenCalledTimes(2)
    // We waited ~25ms (retry-after-ms), not ~10s (would have been baseDelay).
    expect(elapsed).toBeLessThan(500)
  })

  test('uses reduced maxAttempts=2 for shogo-cloud label by default', async () => {
    const { fn } = scriptFetch([
      new Response('overloaded 1', { status: 529 }),
      new Response('overloaded 2', { status: 529 }),
    ])
    const res = await fetchAnthropicWithRetry(
      'https://x',
      { method: 'POST' },
      { label: 'shogo-cloud', baseDelayMs: 1, maxDelayMs: 2 }, // no maxAttempts
    )
    expect(res.status).toBe(529)
    expect(fn).toHaveBeenCalledTimes(2) // 2 attempts for cloud hop (not 3)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// wrapSseForErrorVisibility
// ──────────────────────────────────────────────────────────────────────────────

describe('wrapSseForErrorVisibility', () => {
  test('clean message_stop stream is passed through untouched', async () => {
    const clean =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const wrapped = wrapSseForErrorVisibility(sseStreamFrom([clean]), 'anthropic')
    const out = await collect(wrapped)
    expect(out).toBe(clean)
    expect(out).not.toContain('event: error')
    expect(out).not.toContain('stream_error')
  })

  test('truncated-EOF (no message_stop) injects a typed error frame with code + retryable + meta', async () => {
    const truncated =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'
    const wrapped = wrapSseForErrorVisibility(sseStreamFrom([truncated]), 'anthropic')
    const out = await collect(wrapped)
    expect(out).toStartWith(truncated)
    expect(out).toContain('event: error')

    // Parse the injected error frame
    const errLine = out.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream_error'))!
    const payload: StreamErrorPayload = JSON.parse(errLine.slice(6))
    expect(payload.error.type).toBe('stream_error')
    expect(payload.error.code).toBe('upstream_truncated')
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.meta.chunks).toBe(1)
    expect(payload.error.meta.bytes).toBeGreaterThan(0)
    expect(payload.error.meta.durationMs).toBeGreaterThanOrEqual(0)
    expect(payload.error.message).toContain('message_stop')
  })

  test('mid-stream upstream fault injects a typed error frame with code network_drop', async () => {
    const wrapped = wrapSseForErrorVisibility(
      sseStreamFrom(
        [
          'event: message_start\ndata: {"type":"message_start"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"half"}}\n\n',
        ],
        { errorAfter: 2 }, // throw after 2 chunks
      ),
      'anthropic',
    )
    const out = await collect(wrapped)
    expect(out).toContain('event: error')

    const errLine = out.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream_error'))!
    const payload: StreamErrorPayload = JSON.parse(errLine.slice(6))
    expect(payload.error.code).toBe('network_drop')
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.meta.chunks).toBe(2)
    expect(payload.error.message).toContain('fetch failed')
  })

  test('does NOT inject error when message_stop is split across chunks', async () => {
    const head =
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'data: {"type":"mess'
    const tail = 'age_stop"}\n\n'
    const wrapped = wrapSseForErrorVisibility(sseStreamFrom([head, tail]), 'anthropic')
    const out = await collect(wrapped)
    expect(out).toBe(head + tail)
    expect(out).not.toContain('event: error\ndata:')
  })

  test('emits a keepalive comment when upstream idles beyond keepaliveMs', async () => {
    // 2 chunks with a 50ms gap; keepalive at 20ms should fire at least once.
    const stream = sseStreamFrom(
      [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      { delayMsBetween: 50 },
    )
    const wrapped = wrapSseForErrorVisibility(stream, 'anthropic', {
      keepaliveMs: 20,
    })
    const out = await collect(wrapped)
    expect(out).toContain(': keepalive')
    expect(out).toContain('message_stop')
  })

  test('client-initiated AbortError is propagated cleanly (no synthetic frame)', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException('Aborted', 'AbortError'))
      },
    })
    const wrapped = wrapSseForErrorVisibility(upstream, 'anthropic')
    const out = await collect(wrapped)
    expect(out).not.toContain('event: error')
    expect(out).not.toContain('stream_error')
  })

  test('idle watchdog fires when upstream is silent beyond maxIdleMs', async () => {
    // Upstream sends one chunk then hangs forever.
    let resolveHang: (() => void) | null = null
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (resolveHang) {
          // Second pull — hang until cancelled or test ends.
          await new Promise<void>((r) => { resolveHang = r })
          controller.close()
          return
        }
        controller.enqueue(TE.encode('event: message_start\ndata: {"type":"message_start"}\n\n'))
        resolveHang = () => {}
      },
      cancel() { resolveHang?.() },
    })
    const wrapped = wrapSseForErrorVisibility(upstream, 'anthropic', {
      keepaliveMs: 10,
      maxIdleMs: 50,
      watchdogIntervalMs: 20, // tight interval for testing
    })
    const out = await collect(wrapped)
    expect(out).toContain('event: error')
    const errLine = out.split('\n').find((l) => l.startsWith('data: ') && l.includes('stream_error'))!
    const payload: StreamErrorPayload = JSON.parse(errLine.slice(6))
    expect(payload.error.code).toBe('idle_timeout')
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.message).toContain('No data from anthropic')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// proxyAnthropicStream → OpenAI-compatible conversion (chat-completions path)
//
// Native-Anthropic models reached via the OpenAI chat-completions endpoint
// (e.g. DB-defined models the agent infers as a `custom`/openai-completions
// model) are streamed through this converter. Regression coverage for two
// data-loss bugs that surfaced as a fully-streamed answer being flagged
// "Agent produced no output — possible provider error", plus missing thinking:
//   1. Usage must be relayed as a terminal OpenAI chunk (pi-ai reads
//      completion_tokens from it). Without it the agent saw output=0.
//   2. Anthropic `thinking_delta` must map to `reasoning_content` so reasoning
//      is not silently dropped on this path.
// ──────────────────────────────────────────────────────────────────────────────

/** Parse OpenAI SSE text into the array of `data:` JSON chunks (skips [DONE]). */
function parseOpenAIChunks(sse: string): any[] {
  const chunks: any[] = []
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6).trim()
    if (!data || data === '[DONE]') continue
    try { chunks.push(JSON.parse(data)) } catch { /* ignore non-JSON */ }
  }
  return chunks
}

describe('proxyAnthropicStream → OpenAI conversion (usage relay + thinking)', () => {
  const origFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = origFetch })

  const ANTHROPIC_SSE =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n' +
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me reason. "}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG-should-be-dropped"}}\n\n' +
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello world"}}\n\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n'

  const request: ChatCompletionRequest = {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  }
  const modelConfig: ModelConfig = {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
  }

  test('relays a terminal usage chunk so completion_tokens > 0 (no false "no output")', async () => {
    scriptFetch([new Response(ANTHROPIC_SSE, { status: 200 })])
    let completed: { input: number; output: number; cachedIn: number; cacheWrite: number } | null = null
    const res = await proxyAnthropicStream(request, 'k', modelConfig, (input, output, cachedIn, cacheWrite) => {
      completed = { input, output, cachedIn, cacheWrite }
    })
    const chunks = parseOpenAIChunks(await collect(res.body!))

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk).toBeDefined()
    expect(usageChunk.usage.completion_tokens).toBe(7)
    expect(usageChunk.usage.prompt_tokens).toBe(15) // input_tokens (12) + cache_read (3)
    expect(usageChunk.usage.total_tokens).toBe(22)
    expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toBe(3)
    // Standard OpenAI usage chunk carries no choices.
    expect(usageChunk.choices).toEqual([])

    // Billing side-channel still fires with the real Anthropic numbers.
    expect(completed).toEqual({ input: 12, output: 7, cachedIn: 3, cacheWrite: 0 })
  })

  test('maps Anthropic thinking_delta → reasoning_content and drops signature_delta', async () => {
    scriptFetch([new Response(ANTHROPIC_SSE, { status: 200 })])
    const res = await proxyAnthropicStream(request, 'k', modelConfig)
    const sse = await collect(res.body!)
    const chunks = parseOpenAIChunks(sse)

    const reasoning = chunks
      .map((c) => c.choices?.[0]?.delta?.reasoning_content)
      .filter((v) => typeof v === 'string')
      .join('')
    expect(reasoning).toBe('Let me reason. ')

    const text = chunks
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((v) => typeof v === 'string')
      .join('')
    expect(text).toBe('Hello world')

    // The opaque thinking signature must never leak into the OpenAI stream.
    expect(sse).not.toContain('SIG-should-be-dropped')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Early SSE headers — SHO-517
//
// Cloudflare drops any request that has produced no response headers within
// 125s (HTTP 524). A provider that is slow to its first byte (Gemini on a
// 150k–340k context writing a whole file in one tool call) used to leave the
// proxy silent for longer than that, so the client got HTML and the turn ended
// with "the tool budget for this turn closed".
//
// The windows are scaled down here (10–40ms instead of 10s/120s) so the same
// race is observable: the invariant is "headers before the provider answers",
// not the absolute number.
// ──────────────────────────────────────────────────────────────────────────────

const EARLY_GRACE_MS = 20
const EARLY_KEEPALIVE_MS = 10

/** Resolves with `response` only after `delayMs`, i.e. slower than the grace. */
function slowFetch(response: () => Response, delayMs: number) {
  return () => new Promise<Response>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(response())
      } catch (err) {
        reject(err)
      }
    }, delayMs)
  })
}

const ANTHROPIC_FULL_SSE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"usage":{"input_tokens":40}}}\n\n' +
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"SPLIT_FILE_OK"}}\n\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n\n'

describe('early SSE headers keep a slow provider inside the edge timeout (SHO-517)', () => {
  const origFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = origFetch
    __setEarlySseTimingForTests()
  })

  const anthropicRequest: ChatCompletionRequest = {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'write the whole generator in one file' }],
    stream: true,
  }
  const anthropicConfig: ModelConfig = {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
  }

  test('Anthropic: 200 text/event-stream arrives inside the grace window, keepalives flow, then the real stream', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    scriptFetch([slowFetch(
      () => new Response(ANTHROPIC_FULL_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      120,
    )])

    const completions: Array<{ input: number; output: number }> = []
    const startedAt = Date.now()
    const res = await proxyAnthropicStream(anthropicRequest, 'k', anthropicConfig, (input, output) => {
      completions.push({ input, output })
    })
    const headersAt = Date.now() - startedAt

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    // The whole point: headers long before the provider's 120ms first byte.
    expect(headersAt).toBeLessThan(120)

    const sse = await collect(res.body!)
    expect(sse).toContain(': keepalive')
    expect(sse).toContain('SPLIT_FILE_OK')
    expect(sse).toContain('data: [DONE]')
    // Billing still runs exactly once, when the deferred stream completes.
    expect(completions).toEqual([{ input: 40, output: 9 }])
  })

  test('OpenAI-compatible (Google): same early headers on the Gemini path', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    const googleSse =
      'data: {"choices":[{"delta":{"content":"GEMINI_OK"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n' +
      'data: [DONE]\n\n'
    scriptFetch([slowFetch(
      () => new Response(googleSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      120,
    )])

    const usageCalls: number[][] = []
    const startedAt = Date.now()
    const res = await proxyOpenAIStream(
      {
        model: 'gemini-4-carbon',
        messages: [{ role: 'user', content: 'write the whole generator in one file' }],
        stream: true,
      },
      'k',
      { provider: 'google', apiModel: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon' },
      (input, output) => usageCalls.push([input, output]),
    )
    const headersAt = Date.now() - startedAt

    expect(res.status).toBe(200)
    expect(headersAt).toBeLessThan(120)

    const sse = await collect(res.body!)
    expect(sse).toContain(': keepalive')
    expect(sse).toContain('GEMINI_OK')
    // A completed OpenAI stream must not be mistaken for a truncation.
    expect(sse).not.toContain('upstream_truncated')
    expect(usageCalls).toEqual([[11, 4]])
  })

  test('a provider that 500s after the early headers produces exactly one retryable frame (OpenAI dialect)', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    const res = await proxySseWithEarlyHeaders(
      slowFetch(
        () => new Response('{"error":{"message":"overloaded"}}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
        80,
      ),
      { providerLabel: 'google', dialect: 'openai' },
    )

    expect(res.status).toBe(200)
    const sse = await collect(res.body!)
    const frames = sse.split('\n\n').filter((block) => block.includes('"stream_error"'))
    expect(frames).toHaveLength(1)
    expect(sse).toContain('[shogo:retryable=true;code=upstream_5xx]')
    // An OpenAI SDK throws on a `data: {"error": …}` chunk — that is the shape.
    expect(frames[0]).toStartWith('data: {"type":"error"')
    expect(frames[0]).not.toContain('event: error')
  })

  test('a 403 after the early headers is one non-retryable frame (Anthropic dialect)', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    const res = await proxySseWithEarlyHeaders(
      slowFetch(
        () => new Response('{"error":{"message":"Your credit balance is too low"}}', { status: 403, headers: { 'Content-Type': 'application/json' } }),
        80,
      ),
      { providerLabel: 'anthropic', dialect: 'anthropic' },
    )

    const sse = await collect(res.body!)
    expect(sse.split('\n\n').filter((block) => block.includes('"stream_error"'))).toHaveLength(1)
    expect(sse).toContain('[shogo:retryable=false;code=upstream_rejected]')
    expect(sse).toContain('event: error')
    expect(sse).toContain('credit balance is too low')
  })

  test('a connection that closes after the early headers produces one retryable network frame', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    const res = await proxySseWithEarlyHeaders(
      () => new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(new TypeError('fetch failed')), 80)
      }),
      { providerLabel: 'google', dialect: 'openai' },
    )

    const sse = await collect(res.body!)
    expect(sse.split('\n\n').filter((block) => block.includes('"stream_error"'))).toHaveLength(1)
    expect(sse).toContain('[shogo:retryable=true;code=network_drop]')
  })

  test('a 429 answered inside the grace window keeps its real status (no early headers)', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    // A rate limit is surfaced as a thrown provider error, which the route
    // relays with the real 429 (see the chat-completions catch block). The
    // Anthropic leg is not used here: `fetchAnthropicWithRetry` backs off and
    // re-issues a 429, so the retry — not the first answer — is what the client
    // would see arrive.
    scriptFetch([new Response('{"error":{"message":"rate limited"}}', {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })])

    await expect(
      proxyOpenAIStream(
        { model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hi' }], stream: true },
        'k',
        { provider: 'google', apiModel: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon' },
      ),
    ).rejects.toThrow(/google API error \(429\)/)
  })

  test('a 400 answered inside the grace window keeps its real status (no early headers)', async () => {
    __setEarlySseTimingForTests({ graceMs: EARLY_GRACE_MS, keepaliveMs: EARLY_KEEPALIVE_MS })
    const res = await proxySseWithEarlyHeaders(
      async () => new Response('{"error":{"message":"bad request"}}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
      { providerLabel: 'anthropic', dialect: 'anthropic' },
    )

    // Passed straight through: no 200, no SSE, no synthetic frame.
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('bad request')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// SHO-529: flush the early headers at the grace window, and bound the wait for
// a provider that never answers.
//
// Live evidence from SHO-517's check: the "early" 200 actually reached the
// client at 25.3s (10s grace + one 15s keepalive tick, because Bun writes no
// response head until the first body chunk), and a provider that never answered
// left the stream open until some hop reset it — 300s of plain-text `request
// timeout` on staging, a bare ECONNRESET at 465.7s through the desktop — with no
// typed frame for the agent to act on.
//
// Windows are scaled down here (tens of ms) exactly as in the SHO-517 block: the
// invariants are "the first byte goes out with the headers" and "the cap fires
// before anything else does", not the absolute numbers.
// ──────────────────────────────────────────────────────────────────────────────

describe('early SSE: flush at the grace window, then cap the wait for headers (SHO-529)', () => {
  const origFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = origFetch
    __setEarlySseTimingForTests()
  })

  /** Resolves after `delayMs`, then rejects the way an aborted fetch does. */
  function neverAnswer(): { start: (signal: AbortSignal) => Promise<Response>; aborted: () => boolean } {
    let aborted = false
    return {
      start: (signal: AbortSignal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
          })
        }),
      aborted: () => aborted,
    }
  }

  test('Anthropic: the first body chunk is a keepalive that lands with the headers, not one keepalive later', async () => {
    const GRACE = 20
    const KEEPALIVE = 300
    __setEarlySseTimingForTests({ graceMs: GRACE, keepaliveMs: KEEPALIVE })
    scriptFetch([slowFetch(
      () => new Response(ANTHROPIC_FULL_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      200,
    )])

    const res = await proxyAnthropicStream(
      {
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'write the whole generator in one file' }],
        stream: true,
      },
      'k',
      { provider: 'anthropic', apiModel: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
    )
    expect(res.status).toBe(200)

    // Bun sends no response head until a body chunk exists, so the head is
    // only really out once this read resolves.
    const readAt = Date.now()
    const reader = res.body!.getReader()
    const first = await reader.read()
    const firstChunkAt = Date.now() - readAt
    expect(TD.decode(first.value!)).toContain(': keepalive')
    expect(firstChunkAt).toBeLessThan(KEEPALIVE)
    await reader.cancel()
  })

  test('OpenAI-compatible (Google): same immediate flush on the Gemini path', async () => {
    const GRACE = 20
    const KEEPALIVE = 300
    __setEarlySseTimingForTests({ graceMs: GRACE, keepaliveMs: KEEPALIVE })
    const googleSse =
      'data: {"choices":[{"delta":{"content":"GEMINI_OK"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n' +
      'data: [DONE]\n\n'
    scriptFetch([slowFetch(
      () => new Response(googleSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      200,
    )])

    const res = await proxyOpenAIStream(
      {
        model: 'gemini-4-carbon',
        messages: [{ role: 'user', content: 'write the whole generator in one file' }],
        stream: true,
      },
      'k',
      { provider: 'google', apiModel: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon' },
    )
    expect(res.status).toBe(200)

    const readAt = Date.now()
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(Date.now() - readAt).toBeLessThan(KEEPALIVE)
    expect(TD.decode(first.value!)).toContain(': keepalive')
    await reader.cancel()
  })

  test('a provider that never answers gets exactly one upstream_timeout frame at the cap, and its fetch is aborted', async () => {
    __setEarlySseTimingForTests({ graceMs: 20, keepaliveMs: 10, maxWaitMs: 150 })
    const upstream = neverAnswer()

    const res = await proxySseWithEarlyHeaders(upstream.start, {
      providerLabel: 'google',
      dialect: 'openai',
    })
    expect(res.status).toBe(200)

    const sse = await collect(res.body!)
    const frames = sse.split('\n\n').filter((block) => block.includes('"stream_error"'))
    expect(frames).toHaveLength(1)
    expect(sse).toContain('[shogo:retryable=true;code=upstream_timeout]')
    // The instruction the agent needs: the call that never started is too big.
    expect(sse).toContain('Split large tool calls (e.g. write_file then append).')
    // The upstream request does not keep running in the background.
    expect(upstream.aborted()).toBe(true)
    // Keepalives still flowed before the cap.
    expect(sse).toContain(': keepalive')
  })

  test('the cap writes the Anthropic dialect too (event: error)', async () => {
    __setEarlySseTimingForTests({ graceMs: 20, keepaliveMs: 10, maxWaitMs: 150 })
    const upstream = neverAnswer()

    const res = await proxySseWithEarlyHeaders(upstream.start, {
      providerLabel: 'anthropic',
      dialect: 'anthropic',
    })

    const sse = await collect(res.body!)
    expect(sse.split('\n\n').filter((block) => block.includes('"stream_error"'))).toHaveLength(1)
    expect(sse).toContain('event: error')
    expect(sse).toContain('[shogo:retryable=true;code=upstream_timeout]')
  })

  test('a stream that starts before the cap is never cut, however long it then runs', async () => {
    __setEarlySseTimingForTests({ graceMs: 20, keepaliveMs: 10, maxWaitMs: 150 })
    // Headers at 100ms (before the 150ms cap), then 4 chunks × 60ms = 240ms of
    // body — well past it.
    scriptFetch([() => new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(new Response(
          sseStreamFrom([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"STILL"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"_ALIVE"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ], { delayMsBetween: 60 }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ))
      }, 100)
    })])

    const startedAt = Date.now()
    const res = await proxyAnthropicStream(
      {
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'write the whole generator in one file' }],
        stream: true,
      },
      'k',
      { provider: 'anthropic', apiModel: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
      () => {},
    )

    const sse = await collect(res.body!)
    expect(Date.now() - startedAt).toBeGreaterThan(150)
    expect(sse).toContain('STILL')
    expect(sse).toContain('_ALIVE')
    expect(sse).not.toContain('upstream_timeout')
    expect(sse).not.toContain('[shogo:retryable=')
  })
})
