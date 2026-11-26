// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-596 acceptance — one rewritten piece is one SSE event.
 *
 * `createGeminiNativeSseRewriter` answers a single native event with several
 * OpenAI chunk lines (content + usage, or call + call + finish + usage).
 * `proxyOpenAIStream` wrote them as consecutive `data:` lines, so under the SSE
 * spec they were **one** event whose data is the lines joined with `\n`, and
 * the client `JSON.parse`d `"{…}\n{…}"` and threw `Could not parse message into
 * JSON` on the first chunk of every video turn.
 *
 * The old unit tests could not see this: they asserted the rewriter's string
 * array and never put the bytes through a real SSE client. These tests parse
 * the proxy's actual response body with `openai`'s `Stream.fromSSEResponse` —
 * the parser pi-ai's `openai-completions` provider uses — so the regression
 * fails here on `main` and passes with the fix.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Stream } from 'openai/streaming'
import { proxyOpenAIStream } from '../ai-proxy'

const MODEL = 'gemini-4-hydrogen'
const googleConfig = { provider: 'google' as const, apiModel: MODEL, displayName: 'Gemini 4 Hydrogen' }

let server: ReturnType<typeof Bun.serve> | null = null
let previousGoogleBaseUrl: string | undefined
/** The body the next native `:streamGenerateContent` call returns. */
let nextNativeStream = ''
/** The body the next compat `/chat/completions` call returns. */
let nextCompatStream = ''

/** Google frames its native SSE with CRLF, and puts usageMetadata on every event. */
const nativeSse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')

/** The OpenAI-compatible endpoint frames with LF. */
const compatSse = (lines: string[]): string =>
  lines.map((line) => `${line}\n\n`).join('')

beforeAll(() => {
  previousGoogleBaseUrl = process.env.GOOGLE_BASE_URL
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      await request.json().catch(() => null)
      if (url.pathname.endsWith(':streamGenerateContent')) {
        return new Response(nextNativeStream, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.pathname.endsWith('/chat/completions')) {
        return new Response(nextCompatStream, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    },
  })
  process.env.GOOGLE_BASE_URL = `http://127.0.0.1:${server.port}/v1beta/openai`
}, 30_000)

afterAll(() => {
  server?.stop(true)
  server = null
  if (previousGoogleBaseUrl === undefined) delete process.env.GOOGLE_BASE_URL
  else process.env.GOOGLE_BASE_URL = previousGoogleBaseUrl
})

/** A turn that carries video, so the proxy takes the native route. */
const videoTurn = () => ({
  model: MODEL,
  stream: true,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What happens in this clip?' },
      { type: 'image_url', image_url: { url: 'data:video/mp4;fps=4;base64,AAAA' } },
    ],
  }],
}) as any

/** A plain text turn: same model, no video, so it takes the compat route. */
const textTurn = () => ({
  model: MODEL,
  stream: true,
  messages: [{ role: 'user', content: 'What happens in this clip?' }],
}) as any

type Completion = [number, number, number, number, number]

async function run(
  request: any,
  body: { native?: string; compat?: string },
): Promise<{ chunks: any[]; completions: Completion[] }> {
  nextNativeStream = body.native ?? ''
  nextCompatStream = body.compat ?? ''
  const completions: Completion[] = []
  const response = await proxyOpenAIStream(request, 'test-google-key', googleConfig as any, (...args: Completion) => {
    completions.push(args)
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toContain('text/event-stream')

  // The parser the runtime itself uses. Before the fix this threw on the very
  // first event of a multi-chunk rewrite ("Could not parse message into JSON").
  const chunks: any[] = []
  const stream = Stream.fromSSEResponse(response, new AbortController())
  for await (const chunk of stream) chunks.push(chunk)
  return { chunks, completions }
}

/** Fold the chunk stream into the message the runtime persists. */
function reassemble(chunks: any[]) {
  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let usage: any = null
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>()
  const reasoningDetails: any[] = []

  for (const chunk of chunks) {
    if (chunk?.usage) usage = chunk.usage
    for (const choice of chunk?.choices ?? []) {
      const delta = choice?.delta ?? {}
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (typeof delta.content === 'string') content += delta.content
      if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details)
      for (const call of delta.tool_calls ?? []) {
        const existing = toolCalls.get(call.index) ?? { arguments: '' }
        if (call.id) existing.id = call.id
        if (call.function?.name) existing.name = call.function.name
        existing.arguments += call.function?.arguments ?? ''
        toolCalls.set(call.index, existing)
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
    }
  }

  return {
    content,
    reasoning,
    finishReason,
    usage,
    reasoningDetails,
    toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
  }
}

// ─── AC1: the native video turn ────────────────────────────────────────────
describe('SHO-596 AC1: a native Gemini video turn parses with the real SSE client', () => {
  /** Every event carries usageMetadata, as Google does. */
  const usage = (candidates: number, thoughts: number) => ({
    promptTokenCount: 1200,
    candidatesTokenCount: candidates,
    totalTokenCount: 1200 + candidates + thoughts,
    thoughtsTokenCount: thoughts,
    cachedContentTokenCount: 800,
  })

  const nativeVideoBody = nativeSse([
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'I should look at the clip first.', thought: true }] } }],
      usageMetadata: usage(0, 12),
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'The clip shows a red car.' }] } }],
      usageMetadata: usage(20, 12),
    },
    {
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: { path: 'clip.mp4', fps: 4 } }, thoughtSignature: 'SIG_READ' },
            { functionCall: { name: 'list_files', args: { dir: 'clips' } }, thoughtSignature: 'SIG_LIST' },
          ],
        },
      }],
      usageMetadata: usage(40, 15),
    },
    {
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      usageMetadata: usage(40, 15),
    },
  ])

  it('yields every chunk with no throw and reassembles the whole message', async () => {
    const { chunks } = await run(videoTurn(), { native: nativeVideoBody })
    const message = reassemble(chunks)

    expect(message.reasoning).toBe('I should look at the clip first.')
    expect(message.content).toBe('The clip shows a red car.')
    expect(message.finishReason).toBe('tool_calls')
    expect(message.toolCalls).toEqual([
      { id: 'call_native_1', name: 'read_file', arguments: '{"path":"clip.mp4","fps":4}' },
      { id: 'call_native_2', name: 'list_files', arguments: '{"dir":"clips"}' },
    ])
    expect(message.reasoningDetails).toEqual([
      { type: 'reasoning.encrypted', id: 'call_native_1', data: 'SIG_READ' },
      { type: 'reasoning.encrypted', id: 'call_native_2', data: 'SIG_LIST' },
    ])
    expect(message.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 55,
      total_tokens: 1255,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 15 },
    })

    // one chunk per delta plus one per usage event: 2 + 2 + 3 + 2
    expect(chunks).toHaveLength(9)
    expect(chunks.every((chunk) => chunk.id === 'gemini-native')).toBe(true)
  })

  it('AC3: billing sees each chunk exactly once', async () => {
    const { completions } = await run(videoTurn(), { native: nativeVideoBody })

    // last usageMetadata wins: 1200 prompt with 800 cached → 400 input,
    // 40 candidates + 15 thoughts → 55 output and 15 reasoning.
    expect(completions).toEqual([[400, 55, 800, 15, 0]])
  })
})

// ─── AC2: the same class on the compat path ────────────────────────────────
describe('SHO-596 AC2: the compat Gemini stream frames every rewrite as its own event', () => {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-compat',
      object: 'chat.completion.chunk',
      created: 0,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })}`

  it('(a) a chunk carrying "</thought>answer" splits into two events that both parse', async () => {
    const body = compatSse([
      chunk({ role: 'assistant', content: '<thought>Checking the clip' }),
      chunk({ content: ' frame by frame</thought>A red car drives past.' }),
      `data: ${JSON.stringify({
        id: 'chatcmpl-compat',
        object: 'chat.completion.chunk',
        created: 0,
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 40,
          total_tokens: 1240,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      })}`,
      'data: [DONE]',
    ])

    const { chunks, completions } = await run(textTurn(), { compat: body })
    const message = reassemble(chunks)

    expect(message.reasoning).toBe('Checking the clip frame by frame')
    expect(message.content).toBe('A red car drives past.')
    expect(message.finishReason).toBe('stop')
    expect(completions).toEqual([[400, 40, 800, 0, 0]])
  })

  it('(b) a held "<thought>" prefix drains at [DONE] and the stream still ends', async () => {
    const body = compatSse([chunk({ role: 'assistant', content: '<thou' }), 'data: [DONE]'])

    const { chunks } = await run(textTurn(), { compat: body })
    const message = reassemble(chunks)

    // The held prefix is owed at [DONE] and released as reply text, not
    // thinking. It used to be the second `data:` line of the *same* event as
    // `[DONE]`, so the joined payload neither parsed as JSON nor read as a
    // terminal — now it is its own event and the [DONE] that follows ends the
    // stream (the fixture yields role-only + tail, nothing after the terminal).
    expect(message.content).toBe('<thou')
    expect(message.reasoning).toBe('')
    expect(chunks).toHaveLength(2)
  })

  it('(c) a stream that ends without [DONE] flushes a terminated tail event', async () => {
    const body = compatSse([chunk({ role: 'assistant', content: '<thought>think</thou' })])
    nextNativeStream = ''
    nextCompatStream = body
    const response = await proxyOpenAIStream(textTurn(), 'test-google-key', googleConfig as any, () => {})
    expect(response.status).toBe(200)
    const raw = await response.text()

    // Every event in the body is a complete, parseable event — the flushed
    // tail included. Before the fix `flush()` wrote the tail with no
    // terminating blank line at all, so it merged into whatever came next.
    const events = raw.split('\n\n').filter((event) => event.trim() !== '')
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.startsWith('data: ')).toBe(true)
      const data = event.slice('data: '.length)
      if (data === '[DONE]') continue
      expect(() => JSON.parse(data)).not.toThrow()
    }
    expect(events.some((event) => event.includes('</thou'))).toBe(true)
    // The flushed tail is the last thing written, and it is terminated: an
    // unterminated final event is silently dropped by every SSE client.
    expect(raw.endsWith('\n\n')).toBe(true)

    // With the real client the only failure is the intended truncation report
    // for a body that closed without `[DONE]` — never a JSON parse error.
    let caught: any = null
    try {
      const stream = Stream.fromSSEResponse(
        new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }),
        new AbortController(),
      )
      for await (const _chunk of stream) { /* drain */ }
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    expect(caught.code).toBe('upstream_truncated')
  })
})

// ─── The terminal scan is untouched ───────────────────────────────────────
describe('SHO-596: the truncation scan still reads the upstream body', () => {
  it('a native body cut mid-answer is still reported as upstream_truncated', async () => {
    const body = nativeSse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'The clip shows' }] } }] },
    ])
    nextNativeStream = body
    nextCompatStream = ''
    const response = await proxyOpenAIStream(videoTurn(), 'test-google-key', googleConfig as any, () => {})
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(raw).toContain('upstream_truncated')
    // …and the synthetic frame is still one well-formed event the client parses.
    expect(raw.split('\n\n').filter((event) => event.trim().startsWith('data: {'))).toHaveLength(2)
  })
})
