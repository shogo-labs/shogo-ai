// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `handlers.op()` — the registry-driven media handler, in both transports.
 *
 * BYO mode talks to ElevenLabs directly (fetch stubbed); proxy mode forwards to
 * the Shogo API with the runtime token. One test per transport adapter plus the
 * registry's error contracts; there is deliberately no per-op test, because
 * there is no per-op code.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createVoiceHandlers } from '../server'

const ORIGINAL_RT = process.env.RUNTIME_AUTH_SECRET
const ORIGINAL_PID = process.env.PROJECT_ID
const ORIGINAL_API = process.env.SHOGO_API_URL

beforeEach(() => {
  delete process.env.RUNTIME_AUTH_SECRET
  delete process.env.PROJECT_ID
  delete process.env.SHOGO_API_URL
})

afterEach(() => {
  if (ORIGINAL_RT === undefined) delete process.env.RUNTIME_AUTH_SECRET
  else process.env.RUNTIME_AUTH_SECRET = ORIGINAL_RT
  if (ORIGINAL_PID === undefined) delete process.env.PROJECT_ID
  else process.env.PROJECT_ID = ORIGINAL_PID
  if (ORIGINAL_API === undefined) delete process.env.SHOGO_API_URL
  else process.env.SHOGO_API_URL = ORIGINAL_API
})

type Call = { url: string; init: RequestInit; form?: FormData; json?: unknown }

/** Stub ElevenLabs and record what each call looked like. */
function stubElevenLabs(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const call: Call = {
      url: typeof input === 'string' ? input : String(input),
      init,
      ...(init?.body instanceof FormData ? { form: init.body } : {}),
      ...(typeof init?.body === 'string' && init.body.startsWith('{')
        ? { json: JSON.parse(init.body) }
        : {}),
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return calls
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function byo() {
  return createVoiceHandlers({ apiKey: 'xi_byo', elevenLabsBaseUrl: 'https://el.test' })
}

const audio = (bytes: number[], type = 'audio/mpeg') =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } })

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const file = (name = 'take.mp3', type = 'audio/mpeg') =>
  new File([new Uint8Array([1, 2, 3, 4])], name, { type })

describe('BYO mode — handlers.op()', () => {
  test('json-binary: speech-to-speech is a multipart upload, not JSON', async () => {
    const calls = stubElevenLabs(() => audio([9, 9]))
    const form = new FormData()
    form.set('audio', file())
    form.set('modelId', 'eleven_english_sts_v2')

    const res = await byo().op(
      new Request('http://pod/api/voice/op/speech-to-speech?voiceId=voice_1', {
        method: 'POST',
        body: form,
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([9, 9])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://el.test/v1/speech-to-speech/voice_1')
    const sent = calls[0]!.form!
    expect(sent.get('model_id')).toBe('eleven_english_sts_v2')
    expect(sent.get('audio')).toBeInstanceOf(Blob)
    // Path params stay in the URL.
    expect(sent.get('voice_id')).toBeNull()
    const headers = new Headers(calls[0]!.init.headers as HeadersInit)
    expect(headers.get('xi-api-key')).toBe('xi_byo')
  })

  test('a `voiceId` form part selects the voice, not just ?voiceId=', async () => {
    const calls = stubElevenLabs(() => audio([7]))
    const form = new FormData()
    form.set('audio', file())
    form.set('voiceId', 'voice_from_part')

    const res = await byo().op(
      new Request('http://pod/api/voice/op/speech-to-speech', { method: 'POST', body: form }),
    )

    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('https://el.test/v1/speech-to-speech/voice_from_part')
    expect(calls[0]!.form!.get('voice_id')).toBeNull()
  })

  test('multipart-json: speech-to-text returns the transcription JSON', async () => {
    const calls = stubElevenLabs(() => json({ text: 'hello world', language_code: 'en' }))
    const form = new FormData()
    form.set('file', file('memo.wav', 'audio/wav'))
    form.set('languageCode', 'en')

    const res = await byo().op(
      new Request('http://pod/api/voice/op/speech-to-text', { method: 'POST', body: form }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toMatchObject({ text: 'hello world' })
    expect(calls[0]!.url).toBe('https://el.test/v1/speech-to-text')
    const sent = calls[0]!.form!
    expect(sent.get('file')).toBeInstanceOf(Blob)
    expect(sent.get('model_id')).toBe('scribe_v1')
    expect(sent.get('language_code')).toBe('en')
  })

  test('json-binary: sound-generation posts JSON and returns audio', async () => {
    const calls = stubElevenLabs(() => audio([7]))
    const res = await byo().op(
      new Request('http://pod/api/voice/op/sound-generation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'door creak', durationSeconds: 3 }),
      }),
    )

    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('https://el.test/v1/sound-generation')
    expect(calls[0]!.json).toEqual({
      text: 'door creak',
      duration_seconds: 3,
      model_id: 'eleven_text_to_sound_v2',
    })
  })

  test('json-binary: sound-generation sends output_format as a query param', async () => {
    const calls = stubElevenLabs(() => audio([8]))
    const res = await byo().op(
      new Request('http://pod/api/voice/op/sound-generation?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'door creak' }),
      }),
    )

    expect(res.status).toBe(200)
    // The endpoint takes output_format in the query; a body field is ignored
    // upstream, so it must not be sent that way.
    expect(calls[0]!.url).toBe(
      'https://el.test/v1/sound-generation?output_format=mp3_44100_128',
    )
    expect(calls[0]!.json).toEqual({ text: 'door creak', model_id: 'eleven_text_to_sound_v2' })
  })

  test('json-json: models lists through GET with no body', async () => {
    stubElevenLabs(() => json({ models: [{ model_id: 'eleven_v4' }] }))
    const res = await byo().op(new Request('http://pod/api/voice/op/models'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ models: [{ model_id: 'eleven_v4' }] })
  })

  test('json-json: voices forwards its query params', async () => {
    const calls = stubElevenLabs(() => json({ voices: [] }))
    await byo().op(new Request('http://pod/api/voice/op/voices?page_size=5&search=amy'))
    expect(calls[0]!.url).toBe('https://el.test/v1/voices?page_size=5&search=amy')
  })

  test('the op id may come from ?op= instead of the path', async () => {
    const calls = stubElevenLabs(() => json({ models: [] }))
    await byo().op(new Request('http://pod/api/voice/op?op=models'))
    expect(calls[0]!.url).toBe('https://el.test/v1/models')
  })

  test('an unknown op is a 404 listing every valid id', async () => {
    const calls = stubElevenLabs(() => json({}))
    const res = await byo().op(new Request('http://pod/api/voice/op/voice-changer'))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; allowed: string[] }
    expect(body.error).toBe('unknown_op')
    expect(body.allowed).toContain('speech-to-speech')
    expect(calls).toHaveLength(0)
  })

  test('a GET request to a POST op is a 405 before the network', async () => {
    const calls = stubElevenLabs(() => json({}))
    const res = await byo().op(new Request('http://pod/api/voice/op/speech-to-speech'))
    expect(res.status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  test('validation happens locally: missing file → 400, unknown model → 400', async () => {
    const calls = stubElevenLabs(() => json({}))
    const empty = new FormData()
    expect(
      (await byo().op(new Request('http://pod/api/voice/op/speech-to-speech', {
        method: 'POST',
        body: empty,
      }))).status,
    ).toBe(400)

    const badModel = new FormData()
    badModel.set('audio', file())
    badModel.set('modelId', 'eleven_nope')
    const res = await byo().op(
      new Request('http://pod/api/voice/op/speech-to-speech?voiceId=v', {
        method: 'POST',
        body: badModel,
      }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unknown_model')
    expect(calls).toHaveLength(0)
  })

  test('a missing voiceId in BYO mode is explained, not guessed', async () => {
    const calls = stubElevenLabs(() => audio([1]))
    const form = new FormData()
    form.set('audio', file())
    const res = await byo().op(
      new Request('http://pod/api/voice/op/speech-to-speech', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { detail: string }
    expect(body.detail).toContain('voiceId')
    expect(calls).toHaveLength(0)
  })

  test('an upstream failure is a 502 with the ElevenLabs body', async () => {
    stubElevenLabs(
      () =>
        new Response(JSON.stringify({ detail: { message: 'no such voice' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const form = new FormData()
    form.set('audio', file())
    const res = await byo().op(
      new Request('http://pod/api/voice/op/speech-to-speech?voiceId=v', {
        method: 'POST',
        body: form,
      }),
    )
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('speech-to-speech failed')
    expect(body.detail).toContain('no such voice')
  })

  test('tts and music keep their typed conveniences through the same registry', async () => {
    const calls = stubElevenLabs(() => audio([2]))
    const res = await byo().op(
      new Request('http://pod/api/voice/op/text-to-speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', voiceId: 'voice_1', modelId: 'eleven_v4' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4')
    expect(calls[0]!.url).toBe('https://el.test/v1/text-to-speech/voice_1')
  })
})

describe('proxy mode — handlers.op()', () => {
  type ProxyCall = { url: string; init: RequestInit }

  function proxy() {
    const calls: ProxyCall[] = []
    const fetchImpl = (async (input: any, init: any = {}) => {
      calls.push({ url: typeof input === 'string' ? input : String(input), init })
      return audio([5, 6])
    }) as unknown as typeof fetch
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt_op',
        projectId: 'proj_op',
        apiUrl: 'http://api',
        fetch: fetchImpl,
      },
    })
    return { handlers, calls }
  }

  test('a new op forwards to its canonical hosted path with the runtime token', async () => {
    const { handlers, calls } = proxy()
    const form = new FormData()
    form.set('audio', file())
    form.set('modelId', 'eleven_english_sts_v2')

    const res = await handlers.op(
      new Request('http://pod/api/voice/op/speech-to-speech?voiceId=voice_9', {
        method: 'POST',
        body: form,
      }),
    )

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/speech-to-speech?projectId=proj_op&voiceId=voice_9',
    )
    const headers = new Headers(calls[0]!.init.headers as HeadersInit)
    expect(headers.get('x-runtime-token')).toBe('rt_op')
    // The multipart body is re-encoded by fetch, so it must not carry a
    // frozen content-type with the pod's boundary.
    expect(headers.get('content-type')).toBeNull()
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
  })

  test('a `voiceId` form part rides upstream as a query param', async () => {
    const { handlers, calls } = proxy()
    const form = new FormData()
    form.set('audio', file())
    form.set('voiceId', 'voice_from_part')

    const res = await handlers.op(
      new Request('http://pod/api/voice/op/speech-to-speech', { method: 'POST', body: form }),
    )

    expect(res.status).toBe(200)
    // The rebuilt multipart body has no room for a path param, so dropping it
    // here would make the hosted side pick the project default voice.
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/speech-to-speech?projectId=proj_op&voiceId=voice_from_part',
    )
  })

  test('tts and music still forward to their legacy paths (no client break)', async () => {
    const { handlers, calls } = proxy()
    await handlers.op(
      new Request('http://pod/api/voice/op/text-to-speech', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi' }),
      }),
    )
    await handlers.op(
      new Request('http://pod/api/voice/op/music', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'synthwave' }),
      }),
    )
    expect(calls.map((c) => c.url)).toEqual([
      'http://api/api/voice/tts?projectId=proj_op',
      'http://api/api/voice/music?projectId=proj_op',
    ])
  })

  test('the canonical path is used for ops that never had a legacy one', async () => {
    const { handlers, calls } = proxy()
    await handlers.op(
      new Request('http://pod/api/voice/op/sound-generation', {
        method: 'POST',
        body: JSON.stringify({ text: 'boom' }),
      }),
    )
    expect(calls[0]!.url).toBe('http://api/api/voice/op/sound-generation?projectId=proj_op')
  })

  test('sound-generation forwards output_format upstream as a query param', async () => {
    const { handlers, calls } = proxy()
    await handlers.op(
      new Request('http://pod/api/voice/op/sound-generation?output_format=mp3_44100_128', {
        method: 'POST',
        body: JSON.stringify({ text: 'boom' }),
      }),
    )
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/sound-generation?projectId=proj_op&output_format=mp3_44100_128',
    )
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: 'boom' })
  })

  test('a listing op forwards its query params and no body', async () => {
    const { handlers, calls } = proxy()
    await handlers.op(new Request('http://pod/api/voice/op/voices?page_size=10'))
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/voices?projectId=proj_op&page_size=10',
    )
    expect(calls[0]!.init.body).toBeUndefined()
  })

  test('an upstream 404 becomes 501 with the desktop explanation', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
      },
    })
    const form = new FormData()
    form.set('audio', file())
    const res = await handlers.op(
      new Request('http://pod/api/voice/op/speech-to-speech?voiceId=v', {
        method: 'POST',
        body: form,
      }),
    )
    expect(res.status).toBe(501)
    expect(((await res.json()) as { detail: string }).detail).toContain(
      '/api/voice/op/speech-to-speech returned 404 upstream',
    )
  })

  test('a network failure is a 502 naming the op', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () => {
          throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch,
      },
    })
    const res = await handlers.op(
      new Request('http://pod/api/voice/op/models'),
    )
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('models proxy failed')
  })

  test('elevenLabs.speechToSpeech is hosted in proxy mode', async () => {
    const calls: ProxyCall[] = []
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async (input: any, init: any = {}) => {
          calls.push({ url: typeof input === 'string' ? input : String(input), init })
          return audio([4])
        }) as unknown as typeof fetch,
      },
    })

    const result = await handlers.elevenLabs.speechToSpeech({
      voiceId: 'voice_7',
      audio: file(),
      modelId: 'eleven_multilingual_sts_v2',
    })
    expect(result.contentType).toBe('audio/mpeg')
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/speech-to-speech?projectId=p&voiceId=voice_7',
    )
  })

  test('elevenLabs.transcribe is hosted in proxy mode and returns the JSON', async () => {
    const handlers = createVoiceHandlers({
      proxy: {
        runtimeToken: 'rt',
        projectId: 'p',
        apiUrl: 'http://api',
        fetch: (async () =>
          new Response(JSON.stringify({ text: 'hi there' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      },
    })
    const result = await handlers.elevenLabs.transcribe({ file: file() })
    expect(result.text).toBe('hi there')
  })

  test('an op the proxy cannot serve still throws loudly', async () => {
    const { handlers } = proxy()
    expect(() => handlers.elevenLabs.createAgent).toThrow(
      /not available in runtime-token proxy mode/,
    )
    expect(() => handlers.elevenLabs.voiceExists).toThrow(
      /not available in runtime-token proxy mode/,
    )
  })
})
