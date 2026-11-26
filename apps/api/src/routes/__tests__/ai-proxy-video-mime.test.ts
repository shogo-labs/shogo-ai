// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Video frame settings on the wire (§A.1, §A.3, AC4 — SHO-591 / #2268).
 *
 * `read_file` carries a caller's fps/start/end on the video block's MIME type,
 * because pi-ai serialises a block as `data:${mimeType};base64,…` and that is
 * the only field it passes through. Exactly one route understands them —
 * Google's native `generateContent`. Every other route must see a bare
 * `video/mp4`, or the request fails as an unknown media type, and a Google turn
 * with no video must stay on the compat endpoint byte-for-byte.
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-proxy-video-mime.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { registerDynamicModels, clearDynamicModels } from '@shogo/model-catalog'
import {
  buildOpenAICompatibleBody,
  bridgeVideoContentBlocks,
  proxyOpenAINonStream,
  stripVideoMimeParamsFromMessages,
  usesGeminiNativeVideo,
} from '../ai-proxy'

const PARAM_VIDEO = 'data:video/mp4;fps=10;start=5;end=10;base64,AAAB'
const BARE_VIDEO = 'data:video/mp4;base64,AAAB'

function videoMessages(url: string) {
  return [
    { role: 'user' as const, content: 'watch this' },
    { role: 'user' as const, content: [{ type: 'image_url', image_url: { url } }] },
  ]
}

function google(model = 'gemini-4-hydrogen') {
  return { provider: 'google' as const, apiModel: model }
}

function openrouter() {
  return { provider: 'openrouter' as const, apiModel: 'z-ai/glm-5.3-flash' }
}

describe('stripVideoMimeParamsFromMessages', () => {
  it('removes the frame parameters and keeps the media type and payload', () => {
    const out = stripVideoMimeParamsFromMessages(videoMessages(PARAM_VIDEO) as any) as any[]
    expect(out[1].content[0].image_url.url).toBe(BARE_VIDEO)
  })

  it('returns the same array reference when there is nothing to strip', () => {
    const messages = videoMessages(BARE_VIDEO) as any
    expect(stripVideoMimeParamsFromMessages(messages)).toBe(messages)
  })

  it('leaves text and image blocks untouched', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    ] as any
    expect(stripVideoMimeParamsFromMessages(messages)).toBe(messages)
  })
})

describe('the Google compat body', () => {
  // The compat endpoint has no fps setting and rejects the parameterised media
  // type, so a video block that still carries one must be cleaned before it
  // leaves. A request without video is untouched.
  it('sends a bare media type for a video block that carried parameters', () => {
    const body = buildOpenAICompatibleBody(
      { model: 'gemini-4-hydrogen', messages: videoMessages(PARAM_VIDEO) } as any,
      google() as any,
      {},
    ) as any
    expect(body.messages[1].content[0].image_url.url).toBe(BARE_VIDEO)
    expect(JSON.stringify(body)).not.toContain('fps=')
  })

  it('leaves a Google turn with no video alone', () => {
    const messages = [{ role: 'user', content: 'hi' }] as any
    const body = buildOpenAICompatibleBody({ model: 'gemini-4-hydrogen', messages } as any, google() as any, {}) as any
    expect(body.messages).toEqual(messages)
  })
})

describe('bridgeVideoContentBlocks (OpenRouter)', () => {
  it('rewrites to video_url and strips the parameters OpenRouter cannot read', () => {
    const out = bridgeVideoContentBlocks(videoMessages(PARAM_VIDEO) as any) as any[]
    expect(out[1].content[0]).toEqual({ type: 'video_url', video_url: { url: BARE_VIDEO } })
  })

  it('keeps the array reference for a turn with no video', () => {
    const messages = [{ role: 'user', content: 'hi' }] as any
    expect(bridgeVideoContentBlocks(messages)).toBe(messages)
  })
})

describe('usesGeminiNativeVideo', () => {
  it('routes a Google turn that carries video to the native endpoint', () => {
    expect(usesGeminiNativeVideo({ model: 'gemini-4-hydrogen', messages: videoMessages(PARAM_VIDEO) } as any, google() as any)).toBe(true)
  })

  it('keeps a Google turn without video on the compat path', () => {
    expect(usesGeminiNativeVideo({ model: 'gemini-4-hydrogen', messages: [{ role: 'user', content: 'hi' }] } as any, google() as any)).toBe(false)
  })

  it('never routes a non-Google provider natively, even with video', () => {
    expect(usesGeminiNativeVideo({ model: 'z-ai/glm-5.3-flash', messages: videoMessages(PARAM_VIDEO) } as any, openrouter() as any)).toBe(false)
  })
})

describe('routing: which endpoint a turn actually reaches', () => {
  // The translator is useless if nothing calls it. These stub `fetch` and look
  // at the URL the proxy dialled — the one assertion that proves a video turn
  // escapes the 1 fps compat endpoint, and that every other turn does not.
  const nativeResponse = {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'A clip.' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  }

  async function routeWith(
    native: boolean,
    config: any,
    messages: any[],
    requestModel: string = config.apiModel,
  ) {
    const calls: Array<{ url: string; init: any }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({ url: String(input), init })
      return native
        ? new Response(JSON.stringify(nativeResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any
    try {
      await proxyOpenAINonStream({ model: requestModel, messages } as any, 'test-key', config)
    } finally {
      globalThis.fetch = realFetch
    }
    return calls[0]
  }

  it('sends a Google video turn to native generateContent with videoMetadata', async () => {
    const call = await routeWith(true, google(), videoMessages(PARAM_VIDEO))
    expect(call.url).toContain(':generateContent')
    expect(call.url).not.toContain('/openai')
    expect(call.init.headers['x-goog-api-key']).toBe('test-key')
    const body = JSON.parse(call.init.body)
    const videoPart = body.contents[1].parts[0]
    expect(videoPart.inlineData.mimeType).toBe('video/mp4')
    expect(videoPart.videoMetadata).toEqual({ fps: 10, startOffset: '5s', endOffset: '10s' })
  })

  it('keeps a Google turn without video on the compat endpoint', async () => {
    const call = await routeWith(false, google(), [{ role: 'user', content: 'hi' }])
    expect(call.url).toContain('/chat/completions')
  })

  it('keeps a non-Google video turn on the compat endpoint with the parameters stripped', async () => {
    // The runtime addresses a DB row by its id, so that is what the body
    // builder consults when deciding whether to bridge video to `video_url`.
    registerDynamicModels([
      { id: 'test-glm-row', provider: 'openrouter', apiModel: 'z-ai/glm-5.3-flash', supportsVideoInput: true },
    ])
    try {
      const call = await routeWith(false, openrouter(), videoMessages(PARAM_VIDEO), 'test-glm-row')
      expect(call.url).toContain('/chat/completions')
      const body = JSON.parse(call.init.body)
      expect(body.messages[1].content[0]).toEqual({ type: 'video_url', video_url: { url: BARE_VIDEO } })
      expect(call.init.body).not.toContain('fps=')
    } finally {
      clearDynamicModels()
    }
  })
})
