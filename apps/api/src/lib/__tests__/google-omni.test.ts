// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `lib/google-omni.ts` — the Gemini Omni Interactions contract: request
 * builder, response/usage readers, error mapping. No network: `fetch` is
 * stubbed, and nothing here may reach generativelanguage.googleapis.com.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'

process.env.GOOGLE_BASE_URL = 'https://google.test'

const originalFetch = globalThis.fetch
let calls: Array<{ url: string; init?: RequestInit }> = []
let handler: (url: string, init?: RequestInit) => Response = () => new Response('{}')

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    return handler(url, init)
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  calls = []
  handler = () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
})

const {
  OmniError,
  buildOmniRequest,
  getOmniInteraction,
  mapOmniStatus,
  omniImageBlock,
  readOmniText,
  readOmniUsage,
  readOmniVideo,
  submitOmni,
} = await import('../google-omni')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// =========================================================================
// Request builder
// =========================================================================

describe('buildOmniRequest', () => {
  test('a text-to-video turn is one background interaction', () => {
    const body = buildOmniRequest({
      apiModel: 'gemini-omni-1.2-flash',
      prompt: 'a red paper boat',
      resolution: '360p',
      aspectRatio: '16:9',
      duration: 3,
    })
    expect(body).toEqual({
      model: 'gemini-omni-1.2-flash',
      input: 'a red paper boat',
      response_format: { type: 'video', aspect_ratio: '16:9', resolution: '360p', duration: '3s' },
      // Both are required together: `store:false` breaks `background` and
      // `previous_interaction_id` alike.
      background: true,
      store: true,
    })
  })

  test('caller options come first, so model/input/response_format cannot be redirected', () => {
    const body = buildOmniRequest({
      apiModel: 'gemini-omni-1.2-flash',
      prompt: 'keep me',
      resolution: '720p',
      duration: 5,
      options: { model: 'veo-9', input: 'something else', response_format: { type: 'image' } },
    })
    expect(body.model).toBe('gemini-omni-1.2-flash')
    expect(body.input).toBe('keep me')
    expect(body.response_format).toMatchObject({ type: 'video', resolution: '720p' })
  })

  test('a follow-up turn carries previous_interaction_id and the documented task', () => {
    const body = buildOmniRequest({
      apiModel: 'gemini-omni-1.2-flash',
      prompt: 'make it wooden',
      resolution: '1080p',
      duration: 3,
      task: 'edit',
      previousInteractionId: 'int_1',
    })
    expect(body.previous_interaction_id).toBe('int_1')
    expect(body.generation_config).toEqual({ video_config: { task: 'edit' } })
  })

  test('images become inline blocks after the prompt', () => {
    const body = buildOmniRequest(
      { apiModel: 'gemini-omni-1.2-flash', prompt: 'animate this', resolution: '360p', duration: 3 },
      [
        { type: 'image', data: 'AAAA', mime_type: 'image/png' },
        { type: 'image', data: 'BBBB', mime_type: 'image/jpeg' },
      ],
    )
    expect(body.input).toEqual([
      { type: 'text', text: 'animate this' },
      { type: 'image', data: 'AAAA', mime_type: 'image/png' },
      { type: 'image', data: 'BBBB', mime_type: 'image/jpeg' },
    ])
  })

  test('omits a field the caller did not set', () => {
    const body = buildOmniRequest({ apiModel: 'm', prompt: 'p' })
    expect(body.response_format).toEqual({ type: 'video' })
    expect(body.generation_config).toBeUndefined()
    expect(body.previous_interaction_id).toBeUndefined()
  })
})

// =========================================================================
// Image inlining
// =========================================================================

describe('omniImageBlock', () => {
  test('decodes a base64 data URI', async () => {
    expect(await omniImageBlock('data:image/png;base64,AAAA')).toEqual({
      type: 'image', data: 'AAAA', mime_type: 'image/png',
    })
  })

  test('encodes a percent-encoded (non-base64) data URI', async () => {
    const block = await omniImageBlock('data:image/svg+xml,%3Csvg%2F%3E')
    expect(block.mime_type).toBe('image/svg+xml')
    expect(Buffer.from(block.data, 'base64').toString()).toBe('<svg/>')
  })

  test('fetches an https URL server-side and inlines the bytes', async () => {
    handler = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } })
    const block = await omniImageBlock('https://example.test/a.webp')
    expect(calls[0].url).toBe('https://example.test/a.webp')
    expect(block).toEqual({ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mime_type: 'image/webp' })
  })

  test('rejects anything that is not a data URI or https URL', async () => {
    await expect(omniImageBlock('http://example.test/a.png')).rejects.toBeInstanceOf(OmniError)
    await expect(omniImageBlock('ftp://example.test/a.png')).rejects.toBeInstanceOf(OmniError)
  })

  test('a failed download surfaces the status', async () => {
    handler = () => new Response('nope', { status: 404 })
    const error = await omniImageBlock('https://example.test/missing.png').catch((e) => e)
    expect(error).toBeInstanceOf(OmniError)
    expect(error.status).toBe(404)
  })
})

// =========================================================================
// Wire calls
// =========================================================================

describe('submitOmni / getOmniInteraction', () => {
  test('POSTs to the Interactions API with the key header', async () => {
    handler = () => json({ id: 'int_1', status: 'in_progress' })
    const interaction = await submitOmni('k', { model: 'm' })
    expect(interaction.id).toBe('int_1')
    expect(calls[0].url).toBe('https://google.test/v1beta/interactions')
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as any)['x-goog-api-key']).toBe('k')
  })

  test('unwraps a one-element list response', async () => {
    handler = () => json([{ id: 'int_1', status: 'completed' }])
    expect((await submitOmni('k', {})).id).toBe('int_1')
  })

  test('GET polls the interaction id', async () => {
    handler = () => json({ id: 'int_9', status: 'completed' })
    const interaction = await getOmniInteraction('k', 'int_9')
    expect(interaction.status).toBe('completed')
    expect(calls[0].url).toBe('https://google.test/v1beta/interactions/int_9')
    expect((calls[0].init?.headers as any)['x-goog-api-key']).toBe('k')
  })

  test('an upstream rejection becomes an OmniError carrying the status and body', async () => {
    handler = () => json({ error: { code: 400, message: 'API key not valid' } }, 400)
    const error = await submitOmni('bad', {}).catch((e) => e)
    expect(error).toBeInstanceOf(OmniError)
    expect(error.status).toBe(400)
    expect(error.bodyText).toContain('API key not valid')
    expect(error.message).toContain('400')
  })
})

// =========================================================================
// Readers
// =========================================================================

describe('readOmniVideo', () => {
  test('finds the video block by walking the steps', () => {
    const video = readOmniVideo({
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'here you go' }] },
        { type: 'model_output', content: [{ type: 'video', data: 'AAAA', mime_type: 'video/mp4' }] },
      ],
    })
    expect(video).toEqual({ data: 'AAAA', mimeType: 'video/mp4' })
  })

  test('accepts a uri delivery and defaults the mime type', () => {
    expect(readOmniVideo({ steps: [{ content: [{ type: 'video', uri: 'https://g/v.mp4' }] }] }))
      .toEqual({ uri: 'https://g/v.mp4', mimeType: 'video/mp4' })
  })

  test('is undefined when the turn produced no video', () => {
    expect(readOmniVideo({ steps: [{ content: [{ type: 'text', text: 'blocked' }] }] })).toBeUndefined()
    expect(readOmniVideo({})).toBeUndefined()
  })
})

describe('readOmniUsage', () => {
  test('passes the usage block through', () => {
    expect(readOmniUsage({ usage: { total_input_tokens: 10, output_tokens_by_modality: { video: 5793 } } }))
      .toEqual({ total_input_tokens: 10, output_tokens_by_modality: { video: 5793 } })
  })

  test('is undefined when Google reported nothing billable', () => {
    expect(readOmniUsage({})).toBeUndefined()
    expect(readOmniUsage({ usage: {} })).toBeUndefined()
  })
})

describe('readOmniText / mapOmniStatus', () => {
  test('collects text blocks, then falls back to output_text', () => {
    expect(readOmniText({ steps: [{ content: [{ type: 'text', text: ' nope ' }] }] })).toBe('nope')
    expect(readOmniText({ output_text: 'reason' })).toBe('reason')
    expect(readOmniText({})).toBeUndefined()
  })

  test('maps every documented status', () => {
    expect(mapOmniStatus('completed')).toBe('completed')
    expect(mapOmniStatus('failed')).toBe('failed')
    expect(mapOmniStatus('cancelled')).toBe('failed')
    expect(mapOmniStatus('canceled')).toBe('failed')
    expect(mapOmniStatus('queued')).toBe('queued')
    expect(mapOmniStatus('pending')).toBe('queued')
    expect(mapOmniStatus('in_progress')).toBe('in_progress')
    expect(mapOmniStatus(undefined)).toBe('in_progress')
  })
})
