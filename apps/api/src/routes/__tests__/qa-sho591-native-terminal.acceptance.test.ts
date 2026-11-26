// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-591 acceptance (QA round 2) — every way a *native* Gemini stream can end.
 *
 * The round-1 fix taught the truncation scanner Google's resolved
 * `finishReason`. That is one of the three ways `:streamGenerateContent` ends
 * a body on its own terms; the other two are a mid-stream `{"error": …}` event
 * (which `createGeminiNativeSseRewriter` deliberately forwards verbatim) and a
 * prompt-level block (`promptFeedback.blockReason`, which carries no candidate
 * at all, so there is no `finishReason` to find). Both were still reported as
 * `upstream_truncated` — the runtime's retry classifier maps that to a network
 * fault, so a permanent provider error or a safety block was retried as if the
 * connection had dropped, and the caller was told the wrong reason.
 *
 * Three assertions, and the third one matters as much as the first two: a body
 * that really is cut mid-answer must STILL be reported truncated, so a fix
 * cannot be "stop detecting".
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { proxyOpenAIStream } from '../ai-proxy'

const MODEL = 'gemini-4-hydrogen'

let server: ReturnType<typeof Bun.serve> | null = null
let previousGoogleBaseUrl: string | undefined
/** The native SSE body the next `:streamGenerateContent` call returns. */
let nextStream = ''

const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')

beforeAll(() => {
  previousGoogleBaseUrl = process.env.GOOGLE_BASE_URL
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      await request.json().catch(() => null)
      if (url.pathname.endsWith(':streamGenerateContent')) {
        return new Response(nextStream, { headers: { 'Content-Type': 'text/event-stream' } })
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

const googleConfig = { provider: 'google' as const, apiModel: MODEL, displayName: 'Gemini 4 Hydrogen' }

/** A turn that carries video, so the proxy takes the native route. */
function videoTurn() {
  return {
    model: MODEL,
    stream: true,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What happens in this clip?' },
        { type: 'image_url', image_url: { url: 'data:video/mp4;fps=10;base64,AAAA' } },
      ],
    }],
  } as any
}

async function run(body: string): Promise<string> {
  nextStream = body
  const response = await proxyOpenAIStream(videoTurn(), 'test-google-key', googleConfig as any, () => {})
  expect(response.status).toBe(200)
  return await response.text()
}

describe('a native Gemini stream that ends on its own terms is not "truncated"', () => {
  it('a mid-stream provider error event ends the body — the caller sees that error, not an invented truncation', async () => {
    const raw = await run(sse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Looking at the clip' }] } }] },
      { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } },
    ]))
    // The provider's own error survives …
    expect(raw).toContain('overloaded')
    // … and nothing claims the connection dropped: a 503 is not a network fault,
    // and a synthetic `upstream_truncated` here would send the runtime into a
    // retry loop against a provider that answered.
    expect(raw).not.toContain('upstream_truncated')
  })

  it('a prompt-level safety block ends the body with no candidate and no error', async () => {
    const raw = await run(sse([
      {
        promptFeedback: {
          blockReason: 'SAFETY',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }],
        },
      },
    ]))
    expect(raw).not.toContain('upstream_truncated')
  })

  it('but a body cut mid-answer is still reported as truncated', async () => {
    // No finishReason, no error event, no promptFeedback: a dropped connection.
    const raw = await run(sse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'The clip shows' }] } }] },
    ]))
    expect(raw).toContain('upstream_truncated')
  })
})
