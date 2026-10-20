// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `apps/api/src/routes/voice-media.ts` — hosted `/api/voice/tts` (and the
 * moved `/api/voice/music`).
 *
 * No real ElevenLabs call: `globalThis.fetch` is stubbed. Authorization and
 * the project's default voice are injected through `VoiceMediaDeps`, so the
 * tests need neither a database nor a runtime token.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { voiceMediaRoutes, type VoiceMediaDeps } from '../voice-media'

const originalKey = process.env.ELEVENLABS_API_KEY
const originalFetch = globalThis.fetch

type Call = { url: string; headers: Record<string, string>; body: unknown }

function stubFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v)
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call = { url: typeof input === 'string' ? input : String(input), headers, body }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return calls
}

/** Mount the router with an auth context and injected project deps. */
function makeApp(deps: VoiceMediaDeps = {}) {
  const app = new Hono()
  app.use('/voice/*', async (c, next) => {
    c.set('auth', {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'proj_1',
      isAuthenticated: true,
      via: 'session',
    } as never)
    await next()
  })
  app.route(
    '/',
    voiceMediaRoutes({
      authorize: async () => ({ ok: true, status: 200 }),
      resolveVoiceId: async () => 'voice_default',
      ...deps,
    }),
  )
  return app
}

const post = (app: Hono, path: string, body: unknown) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = 'xi_test_key'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
  else process.env.ELEVENLABS_API_KEY = originalKey
})

describe('POST /voice/tts', () => {
  it('streams audio back with both model headers', async () => {
    const calls = stubFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    )
    const app = makeApp()

    const res = await post(app, '/voice/tts?projectId=proj_1', {
      text: 'Narration check.',
      modelId: 'eleven_v4',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4')
    expect(res.headers.get('x-tts-model-requested')).toBe('eleven_v4')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/v1/text-to-speech/voice_default')
    expect(calls[0]!.headers['xi-api-key']).toBe('xi_test_key')
    expect(calls[0]!.body).toMatchObject({ text: 'Narration check.', model_id: 'eleven_v4' })
  })

  it('defaults the model to eleven_v4_turbo and honours an explicit voiceId', async () => {
    const calls = stubFetch(
      () => new Response(new Uint8Array([0]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    )
    const app = makeApp()
    const res = await post(app, '/voice/tts?projectId=proj_1', { text: 'hi', voiceId: 'voice_custom' })

    expect(res.status).toBe(200)
    expect(calls[0]!.url).toContain('/v1/text-to-speech/voice_custom')
    expect(calls[0]!.body).toMatchObject({ model_id: 'eleven_v4_turbo' })
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4_turbo')
  })

  it('rejects an unknown model with the allowed list (never clamps)', async () => {
    const calls = stubFetch(() => new Response('should not be called', { status: 500 }))
    const app = makeApp()
    const res = await post(app, '/voice/tts?projectId=proj_1', { text: 'x', modelId: 'eleven_nope' })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; allowed: string[] }
    expect(body.error).toBe('unknown_model')
    expect(body.allowed).toContain('eleven_v4')
    expect(body.allowed).toContain('eleven_v4_turbo')
    expect(calls).toHaveLength(0)
  })

  it('rejects text over the model character cap with 413', async () => {
    const calls = stubFetch(() => new Response('nope', { status: 500 }))
    const app = makeApp()
    // eleven_v3 caps at 5_000 characters.
    const res = await post(app, '/voice/tts?projectId=proj_1', {
      text: 'a'.repeat(5_001),
      modelId: 'eleven_v3',
    })

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string; maxChars: number }
    expect(body.error).toBe('text_too_long')
    expect(body.maxChars).toBe(5_000)
    expect(calls).toHaveLength(0)
  })

  it('maps an upstream ElevenLabs error to 502 with the EL body', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ detail: { message: 'voice not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = makeApp()
    const res = await post(app, '/voice/tts?projectId=proj_1', { text: 'hi', modelId: 'eleven_v4' })

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; elBody?: string }
    expect(body.error).toBe('TTS failed')
    expect(body.elBody ?? '').toContain('voice not found')
  })

  it('answers 503 when ELEVENLABS_API_KEY is missing', async () => {
    delete process.env.ELEVENLABS_API_KEY
    const calls = stubFetch(() => new Response('nope', { status: 500 }))
    const app = makeApp()
    const res = await post(app, '/voice/tts?projectId=proj_1', { text: 'hi' })

    expect(res.status).toBe(503)
    const body = (await res.json()) as { detail: string }
    expect(body.detail).toContain('ELEVENLABS_API_KEY')
    expect(calls).toHaveLength(0)
  })

  it('rejects a runtime token scoped to another project with 403', async () => {
    const app = new Hono()
    app.use('/voice/*', async (c, next) => {
      c.set('auth', {
        userId: 'user_1',
        workspaceId: 'ws_1',
        projectId: 'proj_other',
        isAuthenticated: true,
        via: 'runtimeToken',
      } as never)
      await next()
    })
    app.route(
      '/',
      voiceMediaRoutes({
        authorize: async () => ({ ok: true, status: 200 }),
        resolveVoiceId: async () => 'voice_default',
      }),
    )

    const calls = stubFetch(() => new Response('nope', { status: 500 }))
    const res = await post(app, '/voice/tts?projectId=proj_1', { text: 'hi' })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { detail: string }
    expect(body.detail).toContain('scope mismatch')
    expect(calls).toHaveLength(0)
  })

  it('requires projectId', async () => {
    const app = makeApp()
    const res = await post(app, '/voice/tts', { text: 'hi' })
    expect(res.status).toBe(400)
  })
})

describe('POST /voice/music', () => {
  it('streams music audio back', async () => {
    const calls = stubFetch(
      () => new Response(new Uint8Array([4, 5]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    )
    const app = makeApp()
    const res = await post(app, '/voice/music?projectId=proj_1', { prompt: 'synthwave' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([4, 5])
    expect(calls[0]!.url).toContain('/v1/music')
  })

  it('requires exactly one of prompt / compositionPlan', async () => {
    const app = makeApp()
    const res = await post(app, '/voice/music?projectId=proj_1', {
      prompt: 'a',
      compositionPlan: { sections: [] },
    })
    expect(res.status).toBe(400)
  })

  it('maps an upstream failure to 502 with elBody', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'bad plan' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = makeApp()
    const res = await post(app, '/voice/music?projectId=proj_1', { prompt: 'x' })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { elBody?: string }
    expect(body.elBody ?? '').toContain('bad plan')
  })
})
