// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-591 acceptance — the Gemini video path over real HTTP (#2268).
 *
 * The dev's unit tests prove the translator's output in isolation and stub
 * `fetch` to check which URL is dialled. Neither proves the two halves meet:
 * that the bytes the proxy actually sends a Gemini-compatible server carry
 * `videoMetadata`, and that the SSE that server streams back comes out the
 * other side as the same OpenAI chunks `createGoogleSseRewriter` produces —
 * which is what pi-ai, the capture pipeline and `recordUsage` consume.
 *
 * So this file starts a real Bun server that speaks Google's native wire
 * format, points `GOOGLE_BASE_URL` at it, and calls the proxy itself. No
 * API key is needed and nothing leaves the machine.
 *
 * Covered:
 *  - AC1/AC2 mechanic: a video block's fps/start/end reach the provider as
 *    `videoMetadata` (Gemini) and as stripped MIME parameters (every other
 *    provider) — asserted on the bytes on the wire, not on a helper's output.
 *  - AC3 stream half: thoughts, text, parallel function calls with thought
 *    signatures, every finishReason and `usageMetadata` all arrive as the
 *    OpenAI chunks the compat path emits.
 *  - AC3 signature round trip: the follow-up request replays the signature on
 *    the functionCall part, in one merged `user` turn with its result.
 *  - AC6: usage reaches `proxyOpenAIStream`'s completion callback — the hook
 *    that calls `recordUsage` — with prompt, cached, output and reasoning.
 *  - AC4: a Google turn with no video still goes to `/openai/chat/completions`
 *    with an OpenAI-shaped body.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { proxyOpenAINonStream, proxyOpenAIStream } from '../ai-proxy'

const MODEL = 'gemini-4-hydrogen'

interface Captured {
  url: string
  path: string
  search: string
  apiKey: string | null
  body: any
}

const captured: Captured[] = []
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ''
let previousGoogleBaseUrl: string | undefined
let previousOpenRouterBaseUrl: string | undefined

/** Native SSE, shaped exactly like `:streamGenerateContent?alt=sse`. */
function nativeSse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
}

const STREAM_EVENTS = [
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me check the clip. ', thought: true }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'I see F000 and F050. ' }] } }] },
  {
    candidates: [{
      content: {
        role: 'model',
        parts: [{
          functionCall: { name: 'read_file', args: { path: 'clip.mp4', fps: 10 } },
          thoughtSignature: 'sig-abc',
        }],
      },
    }],
  },
  {
    candidates: [{
      content: {
        role: 'model',
        parts: [{
          functionCall: { name: 'grep', args: { pattern: 'F0' } },
          thoughtSignature: 'sig-def',
        }],
      },
      finishReason: 'STOP',
    }],
  },
  {
    candidates: [],
    usageMetadata: {
      promptTokenCount: 1234,
      candidatesTokenCount: 56,
      thoughtsTokenCount: 78,
      cachedContentTokenCount: 900,
      totalTokenCount: 1368,
    },
  },
]

const NON_STREAM_BODY = {
  candidates: [{
    content: {
      role: 'model',
      parts: [
        { text: 'thinking…', thought: true },
        { text: 'The labels are F000, F050, F099.' },
        { functionCall: { name: 'read_file', args: { path: 'clip.mp4' } }, thoughtSignature: 'sig-xyz' },
      ],
    },
    finishReason: 'STOP',
  }],
  usageMetadata: {
    promptTokenCount: 700,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 30,
    cachedContentTokenCount: 0,
    totalTokenCount: 750,
  },
}

beforeAll(() => {
  previousGoogleBaseUrl = process.env.GOOGLE_BASE_URL
  previousOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = await request.json().catch(() => null)
      captured.push({
        url: request.url,
        path: url.pathname,
        search: url.search,
        apiKey: request.headers.get('x-goog-api-key'),
        body,
      })
      if (url.pathname.endsWith(':streamGenerateContent')) {
        return new Response(nativeSse(STREAM_EVENTS), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      if (url.pathname.endsWith(':generateContent')) {
        return new Response(JSON.stringify(NON_STREAM_BODY), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // The OpenAI-compatible endpoint: pi-ai asks for a stream here, and the
      // answer must not look truncated or the proxy injects an error frame.
      if (body?.stream) {
        return new Response(
          `data: ${JSON.stringify({
            id: 'compat-1',
            object: 'chat.completion.chunk',
            created: 0,
            model: MODEL,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'compat reply' }, finish_reason: null }],
          })}\r\n\r\ndata: ${JSON.stringify({
            id: 'compat-1',
            object: 'chat.completion.chunk',
            created: 0,
            model: MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\r\n\r\ndata: [DONE]\r\n\r\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      return new Response(JSON.stringify({
        id: 'compat-1',
        object: 'chat.completion',
        created: 0,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'compat reply' }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  // `getGeminiNativeBaseUrl` strips the compat `/openai` suffix, so setting the
  // compat variable is enough — and it is the same variable staging uses.
  process.env.GOOGLE_BASE_URL = `${baseUrl}/v1beta/openai`
  process.env.OPENROUTER_BASE_URL = `${baseUrl}/api/v1`
}, 30_000)

afterAll(() => {
  server?.stop(true)
  server = null
  if (previousGoogleBaseUrl === undefined) delete process.env.GOOGLE_BASE_URL
  else process.env.GOOGLE_BASE_URL = previousGoogleBaseUrl
  if (previousOpenRouterBaseUrl === undefined) delete process.env.OPENROUTER_BASE_URL
  else process.env.OPENROUTER_BASE_URL = previousOpenRouterBaseUrl
})

const googleConfig = { provider: 'google' as const, apiModel: MODEL, displayName: 'Gemini 4 Hydrogen' }

function videoTurn(mimeType: string) {
  return {
    model: MODEL,
    stream: true,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'How many labelled frames are in this clip?' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,AAAA` } },
      ],
    }],
  } as any
}

/** Every `data: …` payload of an SSE body, parsed. */
async function readChunks(response: Response): Promise<{ chunks: any[]; raw: string }> {
  const raw = await response.text()
  const chunks: any[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice('data: '.length).trim()
    if (!payload || payload === '[DONE]') continue
    chunks.push(JSON.parse(payload))
  }
  return { chunks, raw }
}

describe('AC1/AC3 — a Gemini video turn goes native, and its stream comes back as OpenAI chunks', () => {
  it('sends videoMetadata and returns the compat-shaped stream, with usage on the completion hook', async () => {
    captured.length = 0
    const usage: Array<number[]> = []
    const response = await proxyOpenAIStream(
      videoTurn('video/mp4;fps=10;start=2;end=4'),
      'test-google-key',
      googleConfig as any,
      (...numbers: number[]) => usage.push(numbers),
    )
    expect(response.status).toBe(200)

    // ── the bytes that left the machine ────────────────────────────────────
    expect(captured).toHaveLength(1)
    const sent = captured[0]!
    expect(sent.path).toBe(`/v1beta/models/${MODEL}:streamGenerateContent`)
    expect(sent.search).toBe('?alt=sse')
    expect(sent.apiKey).toBe('test-google-key')
    const videoPart = sent.body.contents.at(-1).parts.find((part: any) => part.inlineData)
    // The parameters ride the MIME type in our request; Google must never see
    // them as part of the media type, only as `videoMetadata`.
    expect(videoPart.inlineData.mimeType).toBe('video/mp4')
    expect(videoPart.videoMetadata).toEqual({ fps: 10, startOffset: '2s', endOffset: '4s' })
    expect(sent.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: true })

    // ── what the client receives ───────────────────────────────────────────
    const { chunks, raw } = await readChunks(response)
    expect(raw).toContain('data: [DONE]')
    // A finished native turn must not be reported as a dropped connection:
    // Google's native SSE ends with `finishReason`, never OpenAI's `[DONE]`, so
    // the truncation scanner has to recognise it — otherwise every Gemini video
    // read appends a retryable `upstream_truncated` error frame after a
    // perfectly good answer, and the runtime retries the whole turn.
    expect(raw).not.toContain('upstream_truncated')

    const deltas = chunks.filter((chunk) => chunk.choices?.length).map((chunk) => chunk.choices[0])
    expect(deltas[0].delta.role).toBe('assistant')
    expect(deltas.map((choice: any) => choice.delta.reasoning_content).filter(Boolean).join(''))
      .toBe('Let me check the clip. ')
    expect(deltas.map((choice: any) => choice.delta.content).filter(Boolean).join(''))
      .toBe('I see F000 and F050. ')

    const toolDeltas = deltas.flatMap((choice: any) => choice.delta.tool_calls ?? [])
    expect(toolDeltas.map((call: any) => call.function.name)).toEqual(['read_file', 'grep'])
    expect(toolDeltas.map((call: any) => call.index)).toEqual([0, 1])
    expect(JSON.parse(toolDeltas[0].function.arguments)).toEqual({ path: 'clip.mp4', fps: 10 })
    // Signatures must survive as reasoning_details, keyed by tool-call id — the
    // shape `applyGoogleThoughtSignatures` reads on the next turn.
    const signatures = deltas.flatMap((choice: any) => choice.delta.reasoning_details ?? [])
    expect(signatures).toEqual([
      { type: 'reasoning.encrypted', id: toolDeltas[0].id, data: 'sig-abc' },
      { type: 'reasoning.encrypted', id: toolDeltas[1].id, data: 'sig-def' },
    ])

    // A turn that calls tools finishes `tool_calls`, not `stop`.
    expect(deltas.at(-1).finish_reason).toBe('tool_calls')

    // ── billing (AC6) ──────────────────────────────────────────────────────
    const usageChunk = chunks.find((chunk) => chunk.usage)
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 1234,
      completion_tokens: 134,
      total_tokens: 1368,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 78 },
    })
    // `proxyOpenAIStream` hands the hook non-cached input separately from the
    // cached prefix, which is what `recordUsage` bills at two rates.
    expect(usage).toEqual([[334, 134, 900, 78, 0]])
  }, 60_000)

  it('replays the signature and the tool result in one native turn', async () => {
    captured.length = 0
    const response = await proxyOpenAIStream(
      {
        model: MODEL,
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look at clip.mp4' },
              // The clip stays in history for the whole conversation, which is
              // what keeps every later turn on the native path.
              { type: 'image_url', image_url: { url: 'data:video/mp4;fps=10;base64,AAAA' } },
            ],
          },
          {
            role: 'assistant',
            content: 'I see F000 and F050.',
            reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: 'sig-abc' }],
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"clip.mp4"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"framesSent":100}' },
        ],
      } as any,
      'test-google-key',
      googleConfig as any,
    )
    await response.text()

    const contents = captured[0]!.body.contents
    const modelTurn = contents.find((turn: any) => turn.role === 'model')
    const functionCallPart = modelTurn.parts.find((part: any) => part.functionCall)
    expect(functionCallPart.thoughtSignature).toBe('sig-abc')

    // The result must live in the immediately following user turn, named after
    // the call — Google validates the pairing inside one turn.
    const resultTurn = contents[contents.indexOf(modelTurn) + 1]
    expect(resultTurn.role).toBe('user')
    expect(resultTurn.parts).toEqual([
      { functionResponse: { name: 'read_file', response: { framesSent: 100 } } },
    ])
  }, 60_000)

  it('answers a non-streaming video turn with the chat.completion shape', async () => {
    captured.length = 0
    const result = await proxyOpenAINonStream(
      { ...videoTurn('video/mp4;fps=24'), stream: false } as any,
      'test-google-key',
      googleConfig as any,
    )
    expect(captured[0]!.path).toBe(`/v1beta/models/${MODEL}:generateContent`)
    const message = (result as any).choices[0].message
    expect(message.role).toBe('assistant')
    expect(message.content).toBe('The labels are F000, F050, F099.')
    expect(message.reasoning_content).toBe('thinking…')
    expect(message.tool_calls[0].function.name).toBe('read_file')
    expect(message.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', id: message.tool_calls[0].id, data: 'sig-xyz' },
    ])
    expect((result as any).usage.completion_tokens).toBe(50)
  }, 60_000)
})

describe('AC4 — a Google turn with no video is unchanged', () => {
  it('still goes to the compat endpoint with an OpenAI-shaped body', async () => {
    captured.length = 0
    const response = await proxyOpenAIStream(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] } as any,
      'test-google-key',
      googleConfig as any,
    )
    await response.text().catch(() => '')
    expect(captured[0]!.path).toBe('/v1beta/openai/chat/completions')
    expect(captured[0]!.body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(captured[0]!.body.contents).toBeUndefined()
    expect(JSON.stringify(captured[0]!.body)).not.toContain('videoMetadata')
  }, 60_000)

  it('strips the frame parameters before a non-Google provider sees the media type', async () => {
    captured.length = 0
    // The runtime addresses a DB row by id, so the body builder needs the row
    // registered to know this model takes video.
    const { registerDynamicModels, clearDynamicModels } = await import('@shogo/model-catalog')
    registerDynamicModels([
      { id: 'qa-glm-row', provider: 'openrouter', apiModel: 'z-ai/glm-5.3-flash', supportsVideoInput: true },
    ])
    try {
      const response = await proxyOpenAIStream(
        { ...videoTurn('video/mp4;fps=10'), model: 'qa-glm-row' } as any,
        'test-openrouter-key',
        { provider: 'openrouter' as const, apiModel: 'z-ai/glm-5.3-flash', displayName: 'GLM 5.3 Flash' } as any,
      )
      await response.text().catch(() => '')
      expect(captured[0]!.path).toBe('/api/v1/chat/completions')
      const sent = JSON.stringify(captured[0]!.body)
      // `video/mp4;fps=10` is an unknown media type to OpenRouter: it must see
      // the bare type, and the block must be bridged to `video_url`.
      expect(sent).not.toContain('fps=')
      expect(captured[0]!.body.messages.at(-1).content.at(-1)).toEqual({
        type: 'video_url',
        video_url: { url: 'data:video/mp4;base64,AAAA' },
      })
    } finally {
      clearDynamicModels()
    }
  }, 60_000)
})
