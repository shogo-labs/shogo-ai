// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `apps/api/src/routes/voice-media.ts` — the hosted `/api/voice/op/:opId`
 * executor.
 *
 * No real ElevenLabs call: `globalThis.fetch` is stubbed. Authorization, the
 * project's default voice and the usage meter are injected through
 * `VoiceMediaDeps`, so these tests need neither a database nor a runtime token.
 *
 * The per-op coverage is one case per transport adapter plus the executor's
 * shared contracts — the registry itself is what decides the rest, and
 * `packages/voice/src/__tests__/ops.test.ts` pins that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { voiceMediaRoutes, type VoiceMediaDeps } from '../voice-media'

const originalKey = process.env.ELEVENLABS_API_KEY
const originalFetch = globalThis.fetch

type Call = { url: string; headers: Record<string, string>; body: unknown; form?: FormData }

function stubFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: Call = {
      url: typeof input === 'string' ? input : String(input),
      headers,
      body,
      ...(init?.body instanceof FormData ? { form: init.body } : {}),
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return calls
}

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
      authorize: async () => ({ ok: true, status: 200, workspaceId: 'ws_1' }),
      resolveVoiceId: async () => 'voice_default',
      // Never touch the usage tables from a test: the meter is asserted
      // through the seam, not through rows.
      recordUsage: async () => {},
      ...deps,
    }),
  )
  return app
}

const audioResponse = (bytes: number[]) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  })

const audioFile = () =>
  new File([new Uint8Array([1, 2, 3, 4])], 'take.mp3', { type: 'audio/mpeg' })

function multipart(
  app: Hono,
  path: string,
  entries: Record<string, string | File>,
) {
  const form = new FormData()
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string') form.set(key, value)
    else form.set(key, value, value.name)
  }
  return app.fetch(new Request(`http://api.test${path}`, { method: 'POST', body: form }))
}

const postJson = (app: Hono, path: string, body: unknown) =>
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

describe('GET|POST /voice/op/:opId — registry contract', () => {
  it('an unknown op is a 404 listing the valid ids', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await postJson(app, '/voice/op/voice-changer?projectId=proj_1', {})
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; allowed: string[] }
    expect(body.error).toBe('unknown_op')
    expect(body.allowed).toEqual(
      expect.arrayContaining(['speech-to-speech', 'sound-generation', 'speech-to-text']),
    )
    expect(calls).toHaveLength(0)
  })

  it('the wrong method is a 405 carrying the op method', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await app.fetch(
      new Request('http://api.test/voice/op/speech-to-speech?projectId=proj_1'),
    )
    expect(res.status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  it('a missing projectId is a 400', async () => {
    const app = makeApp()
    const res = await postJson(app, '/voice/op/sound-generation', { text: 'boom' })
    expect(res.status).toBe(400)
  })

  it('a runtime token scoped to another project is a 403', async () => {
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
    const calls = stubFetch(() => audioResponse([1]))
    const res = await postJson(app, '/voice/op/sound-generation?projectId=proj_1', {
      text: 'boom',
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { detail: string }).detail).toContain('scope mismatch')
    expect(calls).toHaveLength(0)
  })

  it('an oversize body is a 413 with the row limit', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await postJson(app, '/voice/op/sound-generation?projectId=proj_1', {
      text: 'a'.repeat(9 * 1024),
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { maxBytes: number; error: string }
    expect(body.error).toBe('payload_too_large')
    expect(body.maxBytes).toBe(8 * 1024)
    expect(calls).toHaveLength(0)
  })

  it('an oversize upload is refused on content-length, before it is read', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await app.fetch(
      new Request('http://api.test/voice/op/speech-to-speech?projectId=proj_1', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(26 * 1024 * 1024) },
        body: 'x',
      }),
    )
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('no ELEVENLABS_API_KEY is a 503, never a 401 or a 500', async () => {
    delete process.env.ELEVENLABS_API_KEY
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await multipart(app, '/voice/op/speech-to-speech?projectId=proj_1&voiceId=v1', {
      audio: audioFile(),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('voice_unavailable')
    expect(body.detail).toContain('ELEVENLABS_API_KEY')
    expect(calls).toHaveLength(0)
  })
})

describe('multipart-binary — speech-to-speech', () => {
  it('returns converted audio, the model header set and a usage row', async () => {
    const calls = stubFetch(() => audioResponse([4, 5, 6]))
    const metered: { opId: string; units: number }[] = []
    const app = makeApp({
      recordUsage: async ({ op, units }) => {
        metered.push({ opId: op.id, units })
      },
    })

    const res = await multipart(
      app,
      '/voice/op/speech-to-speech?projectId=proj_1&voiceId=voice_9',
      { audio: audioFile(), modelId: 'eleven_english_sts_v2' },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([4, 5, 6])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/v1/speech-to-speech/voice_9')
    expect(calls[0]!.headers['xi-api-key']).toBe('xi_test_key')
    expect(calls[0]!.form!.get('model_id')).toBe('eleven_english_sts_v2')
    expect(calls[0]!.form!.get('audio')).toBeInstanceOf(Blob)
    expect(metered).toEqual([{ opId: 'speech-to-speech', units: 1 }])
  })

  it('a text part where the audio belongs is a 400 (not a 500 downstream)', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await multipart(app, '/voice/op/speech-to-speech?projectId=proj_1&voiceId=v1', {
      audio: 'not really audio',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { detail: string }).detail).toContain('file part')
    expect(calls).toHaveLength(0)
  })

  it('an unknown model is a 400 listing the STS models', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await multipart(app, '/voice/op/speech-to-speech?projectId=proj_1&voiceId=v1', {
      audio: audioFile(),
      modelId: 'eleven_v4',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; allowed: string[] }
    expect(body.error).toBe('unknown_model')
    expect(body.allowed).toContain('eleven_multilingual_sts_v2')
    expect(calls).toHaveLength(0)
  })

  it('falls back to the project default voice when none is named', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp({ resolveVoiceId: async () => 'voice_from_project' })
    const res = await multipart(app, '/voice/op/speech-to-speech?projectId=proj_1', {
      audio: audioFile(),
    })
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toContain('/v1/speech-to-speech/voice_from_project')
  })
})

describe('multipart-json — speech-to-text', () => {
  it('returns the transcription JSON with the default Scribe model', async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ text: 'hello', language_code: 'en' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = makeApp()
    const res = await multipart(app, '/voice/op/speech-to-text?projectId=proj_1', {
      file: audioFile(),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ text: 'hello' })
    expect(calls[0]!.url).toContain('/v1/speech-to-text')
    expect(calls[0]!.form!.get('model_id')).toBe('scribe_v1')
  })

  it('a missing file part is a 400 naming it', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await multipart(app, '/voice/op/speech-to-text?projectId=proj_1', {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('file')
    expect(calls).toHaveLength(0)
  })
})

describe('json-binary — sound-generation', () => {
  it('maps camelCase to the upstream body and meters seconds', async () => {
    const calls = stubFetch(() => audioResponse([7]))
    const metered: number[] = []
    const app = makeApp({ recordUsage: async ({ units }) => metered.push(units) })

    const res = await postJson(app, '/voice/op/sound-generation?projectId=proj_1', {
      text: 'heavy door creaking',
      durationSeconds: 4,
    })

    expect(res.status).toBe(200)
    expect(calls[0]!.body).toEqual({
      text: 'heavy door creaking',
      duration_seconds: 4,
      model_id: 'eleven_text_to_sound_v2',
    })
    expect(metered).toEqual([4])
  })

  it('a missing required field is a 400 before the network', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const res = await postJson(app, '/voice/op/sound-generation?projectId=proj_1', {})
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('an upstream failure is a 502 with the EL body', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ detail: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = makeApp()
    const res = await postJson(app, '/voice/op/sound-generation?projectId=proj_1', {
      text: 'boom',
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; elBody?: string }
    expect(body.error).toBe('sound-generation failed')
    expect(body.elBody ?? '').toContain('quota exceeded')
  })

  it('a plan gate that is off answers 402 without a call', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp({ planGate: async () => false })
    const res = await postJson(app, '/voice/op/sound-generation?projectId=proj_1', {
      text: 'boom',
    })
    expect(res.status).toBe(200) // no row declares a gate yet
    expect(calls).toHaveLength(1)
  })
})

describe('json-json — listings', () => {
  it('GET /voice/op/models returns the model list', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ models: [{ model_id: 'eleven_v4' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = makeApp()
    const res = await app.fetch(
      new Request('http://api.test/voice/op/models?projectId=proj_1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ models: [{ model_id: 'eleven_v4' }] })
  })

  it('GET /voice/op/voices forwards its query params', async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ voices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = makeApp()
    await app.fetch(
      new Request('http://api.test/voice/op/voices?projectId=proj_1&page_size=5&search=amy'),
    )
    expect(calls[0]!.url).toContain('/v1/voices?page_size=5&search=amy')
  })
})

describe('aliases stay equivalent to the registry', () => {
  it('/voice/tts and /voice/op/text-to-speech hit the same ElevenLabs endpoint', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()

    await postJson(app, '/voice/tts?projectId=proj_1', { text: 'hi' })
    await postJson(app, '/voice/op/text-to-speech?projectId=proj_1', {
      text: 'hi',
      voiceId: 'voice_default',
    })

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toContain('/v1/text-to-speech/voice_default')
    }
    // Same model default, same body mapping.
    expect(calls[0]!.body).toMatchObject({ text: 'hi', model_id: 'eleven_v4_turbo' })
    expect(calls[1]!.body).toMatchObject({ text: 'hi', model_id: 'eleven_v4_turbo' })
  })

  it('/voice/op/music reuses the music row (prompt XOR compositionPlan)', async () => {
    const calls = stubFetch(() => audioResponse([1]))
    const app = makeApp()
    const bad = await postJson(app, '/voice/op/music?projectId=proj_1', {
      prompt: 'a',
      compositionPlan: {},
    })
    expect(bad.status).toBe(400)
    const good = await postJson(app, '/voice/op/music?projectId=proj_1', {
      prompt: 'synthwave',
      musicLengthMs: 5000,
    })
    expect(good.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toMatchObject({ prompt: 'synthwave', music_length_ms: 5000 })
  })

  it('an unknown model on the alias is still the alias error contract', async () => {
    const app = makeApp()
    const res = await postJson(app, '/voice/tts?projectId=proj_1', {
      text: 'x',
      modelId: 'nope',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unknown_model')
  })
})
