// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-112 QA acceptance — one voice op registry.
 *
 * Wires the real halves together, the way a generated pod app hits them:
 *
 *   Pod app (real `createVoiceHandlers({})`, runtime-token proxy mode)
 *     → Shogo API app (real `authMiddleware` + real `voiceMediaRoutes()`)
 *       → ElevenLabs (stubbed `fetch`)
 *
 * and separately the BYO half (`createVoiceHandlers({ apiKey })` → EL only).
 *
 * Covers the card's criteria: 1 (STS end to end + a meter row), 2 (503 without
 * a pooled key), 3 (unknown op lists the registry), 4 (413 / 400 / 400 / 502
 * and the aliases' contracts, including the preview line), 5 (every transport
 * in proxy *and* BYO mode).
 *
 * Run: bun test ./apps/api/src/__tests__/qa-voice-op-registry.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const PROJECT_ID = 'proj_voice_op_qa'
const WORKSPACE_ID = 'ws_voice_op_qa'
const OWNER_USER_ID = 'user_voice_op_qa'
const POOLED_KEY = 'xi_pooled_qa'
const BYO_KEY = 'xi_byo_qa'
const PROJECT_VOICE_ID = 'voice_from_project_agent'
const INTERNAL_API = 'http://internal-shogo-api'

// ─── Shogo API mocks ──────────────────────────────────────────────────────
const projects = new Map([[PROJECT_ID, { id: PROJECT_ID, workspaceId: WORKSPACE_ID }]])

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const p = projects.get(args?.where?.id)
      if (!p) return null
      if (args?.select && 'members' in args.select) {
        return {
          workspaceId: p.workspaceId,
          members: [{ userId: OWNER_USER_ID }],
          workspace: { members: [{ userId: OWNER_USER_ID }] },
        }
      }
      return { id: p.id, workspaceId: p.workspaceId, visibility: 'private' }
    }),
  },
  projectAgent: {
    findUnique: mock(async () => ({ voiceId: PROJECT_VOICE_ID })),
    findFirst: mock(async () => null),
    findMany: mock(async () => []),
  },
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => null), findMany: mock(async () => []) },
  workspace: { findUnique: mock(async () => null) },
}

const usageRows: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../auth', () => ({ auth: { api: { getSession: mock(async () => null) } } }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: mock(async () => null) }))

// Keep the real billing module's surface; only the meter is captured, so the
// production `defaultRecordUsage` path runs (the seam is NOT stubbed here).
const realBilling = await import('../services/billing.service')
mock.module('../services/billing.service', () => ({
  ...realBilling,
  consumeUsage: mock(async (row: any) => {
    usageRows.push(row)
  }),
}))

// ─── Real code, imported after the module mocks ───────────────────────────
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { voiceMediaRoutes } = await import('../routes/voice-media')
// Source imports so the spec exercises the working tree, not a stale build.
const { createVoiceHandlers } = await import('../../../../packages/sdk/src/voice/server')
const { GET: opGet, POST: opPost, voiceOpRoutes } = await import(
  '../../../../packages/voice/src/route/op'
)
const { VOICE_OP_IDS, VOICE_OPS } = await import('../../../../packages/voice/src/ops')

// ─── ElevenLabs stub ──────────────────────────────────────────────────────
type ElCall = { url: string; headers: Record<string, string>; body: any; form?: FormData }
let elCalls: ElCall[] = []
let apiHits = 0
let apiApp: Hono
let elRespond: (call: ElCall) => Response

const audioBytes = new Uint8Array([0xff, 0xf3, 0x40, 0x00, 0x11, 0x22])
const okAudio = () => new Response(audioBytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (url.startsWith(INTERNAL_API)) {
      apiHits++
      const u = new URL(url)
      return apiApp.request(`${u.pathname}${u.search}`, init)
    }
    if (url.startsWith('https://api.elevenlabs.io')) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        headers[String(k).toLowerCase()] = String(v)
      }
      const call: ElCall = {
        url,
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        ...(init?.body instanceof FormData ? { form: init.body } : {}),
      }
      elCalls.push(call)
      return elRespond(call)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

// ─── Wiring ───────────────────────────────────────────────────────────────
function createShogoApiApp(): Hono {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.route('/api', voiceMediaRoutes())
  return app
}

/**
 * Pod app in proxy mode: no keys, no proxy config — env auto-detection only.
 * Mounts the shipped `route/op` module exactly as its docstring tells an app
 * to (it reads the op id from the URL itself).
 */
function createPodApp(): Hono {
  const pod = new Hono()
  pod.get('/api/voice/op/:opId', (c) => opGet(c.req.raw))
  pod.post('/api/voice/op/:opId', (c) => opPost(c.req.raw))
  return pod
}

const audioFile = (bytes = 2048) =>
  new File([new Uint8Array(bytes).fill(7)], 'take.mp3', { type: 'audio/mpeg' })

function multipart(path: string, entries: Record<string, string | File | Blob>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string') form.set(key, value)
    else form.set(key, value as any, (value as File).name ?? key)
  }
  return form
}

const runtimeToken = () => deriveRuntimeToken(PROJECT_ID)

/**
 * Both helpers carry the runtime token: a pod sets its own when it proxies,
 * and a direct call to `voiceMediaRoutes` is authenticated by it.
 */
const postForm = (app: Hono, path: string, entries: Record<string, string | File | Blob>) =>
  app.request(path, {
    method: 'POST',
    headers: { 'x-runtime-token': runtimeToken() },
    body: multipart(path, entries),
  })

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken() },
    body: JSON.stringify(body),
  })

const hosted = (path: string) => `/api${path}?projectId=${PROJECT_ID}`

beforeEach(() => {
  process.env.AI_PROXY_SECRET = 'test-signing-secret-sho-112'
  process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(PROJECT_ID)
  process.env.PROJECT_ID = PROJECT_ID
  process.env.SHOGO_API_URL = INTERNAL_API
  process.env.ELEVENLABS_API_KEY = POOLED_KEY

  elCalls = []
  apiHits = 0
  usageRows.length = 0
  elRespond = okAudio
  apiApp = createShogoApiApp()
  installFetch()
})

afterEach(() => {
  installFetch()
})

// ─── AC1 / AC5: the reported bug, end to end ──────────────────────────────

describe('AC1: speech-to-speech (voice changer)', () => {
  test('pod → hosted /voice/op/speech-to-speech returns converted audio on the pooled key, and meters it', async () => {
    const pod = createPodApp()

    const res = await postForm(pod, '/api/voice/op/speech-to-speech', { audio: audioFile() })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(audioBytes)

    // Went through the Shogo API (pooled key), not straight to ElevenLabs.
    expect(apiHits).toBe(1)
    expect(elCalls).toHaveLength(1)
    expect(elCalls[0].headers['xi-api-key']).toBe(POOLED_KEY)
    // Project's default voice is a URL path segment; the model is a form part.
    expect(elCalls[0].url).toContain(`/v1/speech-to-speech/${PROJECT_VOICE_ID}`)
    expect(elCalls[0].form?.get('model_id')).toBe('eleven_multilingual_sts_v2')
    expect(elCalls[0].form?.get('audio')).toBeInstanceOf(Blob)
    // The voice id travels in the URL, never as a duplicate multipart part.
    expect(elCalls[0].form?.get('voice_id')).toBeNull()

    // AC1: a metering row, keyed by the registry row.
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0]).toMatchObject({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      actionType: 'voice_media_usage',
      actionMetadata: { opId: 'speech-to-speech', unit: 'second' },
    })
    expect(usageRows[0].actionMetadata.units).toBeGreaterThan(0)
  })

  test('the hosted op path works with a runtime token and no pod in front of it', async () => {
    const res = await postForm(apiApp, `${hosted('/voice/op/speech-to-speech')}&voiceId=voice_caller_choice`, {
      audio: audioFile(),
    })

    expect(res.status).toBe(200)
    expect(elCalls[0].url).toContain('/v1/speech-to-speech/voice_caller_choice')
  })

  test('a `voiceId` form part selects the voice, not just ?voiceId=', async () => {
    const res = await postForm(apiApp, hosted('/voice/op/speech-to-speech'), {
      audio: audioFile(),
      voiceId: 'voice_from_form_part',
    })

    expect(res.status).toBe(200)
    expect(elCalls[0].url).toContain('/v1/speech-to-speech/voice_from_form_part')
  })

  test('a `voiceId` form part survives the pod proxy too', async () => {
    const res = await postForm(createPodApp(), '/api/voice/op/speech-to-speech', {
      audio: audioFile(),
      voiceId: 'voice_via_pod',
    })

    expect(res.status).toBe(200)
    expect(apiHits).toBe(1)
    expect(elCalls[0].url).toContain('/v1/speech-to-speech/voice_via_pod')
  })

  test('a runtime token for another project is a 403, not a charge', async () => {
    apiHits = 0
    const res = await apiApp.request(`/api/voice/op/speech-to-speech?projectId=someone_else`, {
      method: 'POST',
      headers: { 'x-runtime-token': deriveRuntimeToken(PROJECT_ID) },
      body: multipart('', { audio: audioFile() }),
    })

    expect(res.status).toBe(403)
    expect(elCalls).toHaveLength(0)
    expect(usageRows).toHaveLength(0)
  })
})

describe('AC2: no pooled key', () => {
  test('is a 503 with a specific message — never 401, never 500', async () => {
    delete process.env.ELEVENLABS_API_KEY

    const res = await postForm(apiApp, hosted('/voice/op/speech-to-speech'), { audio: audioFile() })

    expect(res.status).toBe(503)
    const body: any = await res.json()
    expect(body.error).toBe('voice_unavailable')
    expect(body.detail).toContain('ELEVENLABS_API_KEY')
    expect(elCalls).toHaveLength(0)
  })
})

describe('AC3: registry invariants', () => {
  test('an unknown op is a 404 that lists the registry ids, on both surfaces', async () => {
    const hostedRes = await postJson(apiApp, hosted('/voice/op/nope'), {})
    expect(hostedRes.status).toBe(404)
    const hostedBody: any = await hostedRes.json()
    expect(hostedBody.error).toBe('unknown_op')
    expect(hostedBody.allowed).toEqual([...VOICE_OP_IDS])

    const podRes = await postJson(createPodApp(), '/api/voice/op/nope', {})
    expect(podRes.status).toBe(404)
    const podBody: any = await podRes.json()
    expect(podBody.allowed).toEqual([...VOICE_OP_IDS])
  })

  test('every row decides its permission, its body limit and who pays', () => {
    for (const op of VOICE_OPS as readonly any[]) {
      expect(op.permission).toBeTruthy()
      expect(typeof op.maxBodyBytes).toBe('number')
      expect(op.cost !== undefined || op.byoOnly === true).toBe(true)
      expect(op.hostedPath).toBe(`/voice/op/${op.id}`)
    }
  })
})

describe('AC4: limits, bodies and upstream failures', () => {
  test('an unknown model is a 400 listing the models, with no upstream call', async () => {
    const res = await postForm(apiApp, hosted('/voice/op/speech-to-speech'), {
      audio: audioFile(),
      modelId: 'eleven_nope_sts',
    })

    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.error).toBe('unknown_model')
    expect(body.allowed).toContain('eleven_multilingual_sts_v2')
    expect(elCalls).toHaveLength(0)
  })

  test('a text field where a file part is required is a 400, not an upstream call', async () => {
    const res = await postForm(apiApp, hosted('/voice/op/speech-to-speech'), {
      audio: 'not-a-file',
    })

    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.error).toBe('Missing `audio` file part')
    expect(body.detail).toContain('file part')
    expect(elCalls).toHaveLength(0)
  })

  test('a body over the row limit is a 413 carrying the limit (actual size)', async () => {
    const oversize = await postJson(apiApp, hosted('/voice/op/sound-generation'), {
      text: 'x'.repeat(9000),
    })
    expect(oversize.status).toBe(413)
    const body: any = await oversize.json()
    expect(body.error).toBe('payload_too_large')
    expect(body.maxBytes).toBe(8 * 1024)
    expect(elCalls).toHaveLength(0)
  })

  test('an oversize multipart upload is a 413 before any upstream call', async () => {
    const res = await postForm(apiApp, hosted('/voice/op/speech-to-speech'), {
      audio: audioFile(25 * 1024 * 1024 + 8),
    })
    expect(res.status).toBe(413)
    expect(elCalls).toHaveLength(0)
  })

  test('an upstream failure is a 502 { error, detail }', async () => {
    elRespond = () =>
      new Response(JSON.stringify({ detail: { status: 'quota_exceeded' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })

    const res = await postForm(apiApp, hosted('/voice/op/speech-to-speech'), { audio: audioFile() })

    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.error).toBe('speech-to-speech failed')
    expect(typeof body.detail).toBe('string')
  })
})

describe('AC5: every transport, in proxy mode and BYO mode', () => {
  type Case = {
    opId: string
    request: (app: Hono, path: (p: string) => string) => Promise<Response>
    elPath: string
    byoQuery: string
    expect: 'audio' | 'json'
  }

  const cases: Case[] = [
    {
      opId: 'sound-generation',
      request: (app, path) => postJson(app, path('/voice/op/sound-generation'), { text: 'door creak' }),
      elPath: '/v1/sound-generation',
      byoQuery: '',
      expect: 'audio',
    },
    {
      opId: 'speech-to-speech',
      request: (app, path) => postForm(app, path('/voice/op/speech-to-speech'), { audio: audioFile() }),
      elPath: '/v1/speech-to-speech/',
      byoQuery: '&voiceId=voice_byo',
      expect: 'audio',
    },
    {
      opId: 'speech-to-text',
      request: (app, path) => postForm(app, path('/voice/op/speech-to-text'), { file: audioFile() }),
      elPath: '/v1/speech-to-text',
      byoQuery: '',
      expect: 'json',
    },
    {
      opId: 'text-to-speech-with-timestamps',
      request: (app, path) =>
        postJson(app, path('/voice/op/text-to-speech-with-timestamps'), {
          text: 'caption me',
          voiceId: 'voice_ts',
        }),
      elPath: '/v1/text-to-speech/voice_ts/with-timestamps',
      byoQuery: '',
      expect: 'json',
    },
  ]

  for (const c of cases) {
    test(`${c.opId} (${c.expect}) — proxy mode goes through the Shogo API`, async () => {
      elRespond = () => (c.expect === 'json' ? okJson({ ok: true, text: 'hi' }) : okAudio())
      const pod = createPodApp()

      const res = await c.request(pod, (p) => `/api${p}?projectId=${PROJECT_ID}`)

      expect(res.status).toBe(200)
      expect(apiHits).toBe(1)
      expect(elCalls).toHaveLength(1)
      expect(elCalls[0].url).toContain(c.elPath)
      expect(elCalls[0].headers['xi-api-key']).toBe(POOLED_KEY)
      if (c.expect === 'json') expect(((await res.json()) as any).text).toBe('hi')
      else expect(res.headers.get('content-type')).toBe('audio/mpeg')
    })

    test(`${c.opId} (${c.expect}) — BYO mode calls ElevenLabs directly`, async () => {
      elRespond = () => (c.expect === 'json' ? okJson({ ok: true, text: 'hi' }) : okAudio())
      const handlers = createVoiceHandlers({ apiKey: BYO_KEY })
      const pod = new Hono()
      pod.all('/api/voice/op/:opId', (req) => handlers.op(req.req.raw, req.req.param('opId')))

      const res = await c.request(pod, (p) => `/api${p}?x=1${c.byoQuery}`)

      expect(res.status).toBe(200)
      expect(apiHits).toBe(0)
      expect(elCalls).toHaveLength(1)
      expect(elCalls[0].url).toContain(c.elPath)
      expect(elCalls[0].headers['xi-api-key']).toBe(BYO_KEY)
    })
  }

  test('sound-generation forwards output_format as a query param, not a body field', async () => {
    const res = await postJson(
      apiApp,
      `${hosted('/voice/op/sound-generation')}&output_format=mp3_44100_128`,
      { text: 'coin drop' },
    )

    expect(res.status).toBe(200)
    expect(elCalls[0].url).toContain('output_format=mp3_44100_128')
    expect(elCalls[0].body.output_format).toBeUndefined()
  })

  test('the keyed route map serves an op by name (the named-route surface)', async () => {
    elRespond = () => okAudio()
    const pod = new Hono()
    pod.post('/api/voice/spend', (c) => voiceOpRoutes['sound-generation'].POST(c.req.raw))

    const res = await pod.request('/api/voice/spend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken() },
      body: JSON.stringify({ text: 'coin drop' }),
    })

    expect(res.status).toBe(200)
    expect(elCalls[0]?.url ?? '').toContain('/v1/sound-generation')
    expect(apiHits).toBe(1)
  })

  test('the listing ops serve GET through both surfaces', async () => {
    elRespond = () => okJson({ voices: [{ voice_id: 'v1' }] })
    const pod = createPodApp()

    const proxy = await pod.request(`/api/voice/op/voices?projectId=${PROJECT_ID}`, {
      method: 'GET',
      headers: { 'x-runtime-token': runtimeToken() },
    })
    expect(proxy.status).toBe(200)
    expect(((await proxy.json()) as any).voices).toHaveLength(1)
    expect(apiHits).toBe(1)

    apiHits = 0
    elCalls = []
    const hostedRes = await apiApp.request(hosted('/voice/op/voices'), {
      method: 'GET',
      headers: { 'x-runtime-token': runtimeToken() },
    })
    expect(hostedRes.status).toBe(200)
    expect(elCalls[0].url).toContain('/v1/voices')
    expect(elCalls[0].headers['xi-api-key']).toBe(POOLED_KEY)
  })
})

// ─── AC4: the aliases keep their own contracts ────────────────────────────

describe('aliases: /voice/tts and /voice/music are unchanged', () => {
  test('/voice/tts still returns audio with both model headers', async () => {
    const res = await postJson(apiApp, hosted('/voice/tts'), { text: 'hello', modelId: 'eleven_v4' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-model-used')).toBe('eleven_v4')
    expect(res.headers.get('x-tts-model-requested')).toBe('eleven_v4')
    expect(elCalls[0].url).toContain(`/v1/text-to-speech/${PROJECT_VOICE_ID}`)
  })

  test('/voice/tts builds a preview line from audioTags when no text is sent', async () => {
    const res = await postJson(apiApp, hosted('/voice/tts'), {
      audioTags: ['laughs'],
      characterName: 'Ada',
    })

    expect(res.status).toBe(200)
    expect(elCalls).toHaveLength(1)
    // Exactly what main sent upstream for this body (measured on 701ab2d74).
    expect(String(elCalls[0].body.text)).toBe(
      '[laughs] Hey — this is how Ada sounds when the mood takes over.',
    )
  })

  test("the pod's own tts alias builds the same preview line before forwarding", async () => {
    const handlers = createVoiceHandlers({})
    const res = await handlers.tts(
      new Request('http://pod/api/voice/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioTags: ['laughs'], characterName: 'Ada' }),
      }),
    )

    expect(res.status).toBe(200)
    expect(apiHits).toBe(1)
    expect(elCalls[0].headers['xi-api-key']).toBe(POOLED_KEY)
    expect(String(elCalls[0].body.text)).toBe(
      '[laughs] Hey — this is how Ada sounds when the mood takes over.',
    )
  })

  test('/voice/music keeps its prompt/compositionPlan rule', async () => {
    const both = await postJson(apiApp, hosted('/voice/music'), {
      prompt: 'lofi',
      compositionPlan: { sections: [] },
    })
    expect(both.status).toBe(400)

    const ok = await postJson(apiApp, hosted('/voice/music'), { prompt: 'lofi', musicLengthMs: 5000 })
    expect(ok.status).toBe(200)
    expect(elCalls[0].url).toContain('/v1/music')
  })
})
