// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-232 — a Google key also drives music on `POST /api/voice/music`.
 *
 * The route keeps ElevenLabs as its provider and adds Google's Lyria behind
 * `provider: 'google'`, riding the same key resolution the AI proxy uses
 * (`getNativeProviderApiKeySync('google')`). What is asserted here:
 *
 *   1. a Google key + `provider: 'google'` renders through Lyria and meters it
 *   2. no Google key → ElevenLabs still renders, and the response says why
 *   3. no `provider` → ElevenLabs only, unchanged shape and no Google call
 *   4. the two providers' fields do not cross over (400, never a silent drop)
 *   5. an upstream Lyria failure is a 502 carrying Google's status
 *
 * Run: bun test ./apps/api/src/__tests__/voice-music-google.test.ts
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const PROJECT_ID = 'proj_voice_music_google'
const WORKSPACE_ID = 'ws_voice_music_google'
const OWNER_USER_ID = 'user_voice_music_google'
const POOLED_KEY = 'xi_pooled_music_qa'
const GOOGLE_KEY = 'google_music_qa_key'
const INTERNAL_API = 'http://internal-shogo-api'
const GOOGLE_HOST = 'https://generativelanguage.googleapis.com'

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
  projectAgent: { findUnique: mock(async () => null), findFirst: mock(async () => null) },
  platformSetting: { findMany: mock(async () => []) },
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => null), findMany: mock(async () => []) },
  workspace: { findUnique: mock(async () => null) },
}

const usageRows: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../auth', () => ({ auth: { api: { getSession: mock(async () => null) } } }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: mock(async () => null) }))

const realBilling = await import('../services/billing.service')
mock.module('../services/billing.service', () => ({
  ...realBilling,
  consumeUsage: mock(async (row: any) => {
    usageRows.push(row)
  }),
}))

const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { voiceMediaRoutes } = await import('../routes/voice-media')

// ─── Upstream stubs ───────────────────────────────────────────────────────
type UpstreamCall = { url: string; headers: Record<string, string>; body: any }
let upstreamCalls: UpstreamCall[] = []
let apiApp: Hono
let googleRespond: () => Response

const elAudio = new Uint8Array([0xff, 0xf3, 0x40, 0x00, 0x11, 0x22])
const lyriaAudio = Buffer.from('lyria-bytes').toString('base64')

const okAudio = () => new Response(elAudio, { status: 200, headers: { 'content-type': 'audio/mpeg' } })

/** The Interactions response shape: audio arrives inline as a base64 block. */
const lyriaResponse = (audio: string | null = lyriaAudio) =>
  new Response(
    JSON.stringify({
      id: 'interaction_qa',
      steps: audio
        ? [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data: audio }] }]
        : [{ type: 'model_output', content: [{ type: 'text', text: 'no music for that prompt' }] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (url.startsWith(INTERNAL_API)) {
      const u = new URL(url)
      return apiApp.request(`${u.pathname}${u.search}`, init)
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[String(k).toLowerCase()] = String(v)
    const call: UpstreamCall = {
      url,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    }
    upstreamCalls.push(call)
    if (url.startsWith(GOOGLE_HOST)) return googleRespond()
    if (url.startsWith('https://api.elevenlabs.io')) return okAudio()
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

const runtimeToken = () => deriveRuntimeToken(PROJECT_ID)

const postMusic = (body: unknown) =>
  apiApp.request(`/api/voice/music?projectId=${PROJECT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken() },
    body: JSON.stringify(body),
  })

const googleCalls = () => upstreamCalls.filter((call) => call.url.startsWith(GOOGLE_HOST))
const elevenLabsCalls = () => upstreamCalls.filter((call) => call.url.startsWith('https://api.elevenlabs.io'))

beforeEach(() => {
  process.env.AI_PROXY_SECRET = 'test-signing-secret-sho-232'
  process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(PROJECT_ID)
  process.env.PROJECT_ID = PROJECT_ID
  process.env.SHOGO_API_URL = INTERNAL_API
  process.env.ELEVENLABS_API_KEY = POOLED_KEY
  process.env.GOOGLE_API_KEY = GOOGLE_KEY
  delete process.env.GOOGLE_BASE_URL

  upstreamCalls = []
  usageRows.length = 0
  googleRespond = () => lyriaResponse()

  apiApp = new Hono()
  apiApp.use('*', authMiddleware)
  apiApp.route('/api', voiceMediaRoutes())
  installFetch()
})

afterEach(() => {
  delete process.env.GOOGLE_API_KEY
  installFetch()
})

// ─── AC1: Lyria renders and is metered ────────────────────────────────────

describe('AC1: provider google renders through Lyria', () => {
  test('returns Lyria audio bytes, calls the Interactions API with the Google key, and meters it', async () => {
    const res = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-music-provider')).toBe('google')
    expect(res.headers.get('x-music-model')).toBe('lyria-3-clip')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('lyria-bytes')

    expect(elevenLabsCalls()).toHaveLength(0)
    expect(googleCalls()).toHaveLength(1)
    const call = googleCalls()[0]
    expect(call.url).toBe(`${GOOGLE_HOST}/v1beta/interactions`)
    expect(call.headers['x-goog-api-key']).toBe(GOOGLE_KEY)
    expect(call.body.model).toBe('lyria-3-clip-preview')
    expect(call.body.input).toBe('warm lofi piano loop')

    expect(usageRows).toHaveLength(1)
    expect(usageRows[0].actionMetadata).toMatchObject({
      opId: 'music',
      unit: 'second',
      provider: 'google',
      model: 'lyria-3-clip',
    })
    expect(usageRows[0].actionMetadata.units).toBe(30)
  })

  test('`model: lyria-3.5` sends the full-song model and meters the track', async () => {
    const res = await postMusic({ prompt: 'a full synthwave song', provider: 'google', model: 'lyria-3.5' })

    expect(res.status).toBe(200)
    expect(googleCalls()[0].body.model).toBe('lyria-3.5')
    expect(res.headers.get('x-music-model')).toBe('lyria-3.5')
    expect(usageRows[0].actionMetadata.model).toBe('lyria-3.5')
    // A full song's length is prompt-controlled, so the row says the seconds
    // are an assumption rather than passing them off as measured.
    expect(usageRows[0].actionMetadata.unitsEstimated).toBe(true)
  })

  test('a fixed-length model is metered as measured, not estimated', async () => {
    await postMusic({ prompt: 'a sting', provider: 'google' })
    expect(usageRows[0].actionMetadata.unitsEstimated).toBeUndefined()
  })

  test('lyrics and instrumental reach Lyria through the prompt, as the API requires', async () => {
    await postMusic({ prompt: 'ballad', provider: 'google', lyrics: '[Verse] hello' })
    expect(googleCalls()[0].body.input).toContain('Use exactly these lyrics:\n[Verse] hello')

    upstreamCalls = []
    await postMusic({ prompt: 'ballad', provider: 'google', instrumental: true })
    expect(googleCalls()[0].body.input).toContain('Instrumental only, no vocals.')
  })

  test('Lyria needs no ElevenLabs key at all', async () => {
    // A desktop that only ever configured a Google key still gets music; the
    // provider branch must not fall through the pooled-key check.
    delete process.env.ELEVENLABS_API_KEY

    const res = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('google')
    expect(elevenLabsCalls()).toHaveLength(0)
  })

  test('the generic op route honours `provider` too, so a pod app gets Lyria', async () => {
    // `/api/voice/op/music` is the route a generated pod app calls; it parses
    // through the same registry row, so the field must not be stripped there.
    const res = await apiApp.request(`/api/voice/op/music?projectId=${PROJECT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken() },
      body: JSON.stringify({ prompt: 'warm lofi piano loop', provider: 'google' }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('google')
    expect(googleCalls()).toHaveLength(1)
    expect(elevenLabsCalls()).toHaveLength(0)
  })
})

// ─── AC2: no Google key falls back, and says so ───────────────────────────

describe('AC2: a missing Google key falls back to ElevenLabs with a reason', () => {
  test('renders ElevenLabs Music and reports the fallback', async () => {
    delete process.env.GOOGLE_API_KEY

    const res = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('elevenlabs')
    expect(res.headers.get('warning')).toContain('no Google API key is configured')
    expect(googleCalls()).toHaveLength(0)
    expect(elevenLabsCalls()).toHaveLength(1)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(elAudio))
  })
})

// ─── AC3: ElevenLabs behaviour is unchanged ───────────────────────────────

describe('AC3: no provider requested means ElevenLabs, exactly as before', () => {
  test('renders ElevenLabs Music with no Google call and no fallback warning', async () => {
    const res = await postMusic({ prompt: 'warm lofi piano loop' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('elevenlabs')
    expect(res.headers.get('warning')).toBeNull()
    expect(googleCalls()).toHaveLength(0)
    expect(elevenLabsCalls()[0].body.prompt).toBe('warm lofi piano loop')
  })

  test('`provider: elevenlabs` behaves the same, and the prompt/compositionPlan rule still holds', async () => {
    const ok = await postMusic({ prompt: 'lofi', provider: 'elevenlabs' })
    expect(ok.status).toBe(200)

    const both = await postMusic({
      prompt: 'lofi',
      compositionPlan: { sections: [] },
      provider: 'elevenlabs',
    })
    expect(both.status).toBe(400)
    expect((await both.json()).error).toContain('exactly one of')
  })
})

// ─── AC4: the providers' fields do not cross over ─────────────────────────

describe('AC4: provider fields are validated, never silently dropped', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an unknown provider', { prompt: 'x', provider: 'openai' }, "'elevenlabs' or 'google'"],
    ['an unknown Lyria model', { prompt: 'x', provider: 'google', model: 'lyria-9' }, "Unknown music model 'lyria-9'"],
    ['compositionPlan with google', { compositionPlan: { sections: [] }, provider: 'google' }, 'ElevenLabs-only'],
    ['modelId with google', { prompt: 'x', provider: 'google', modelId: 'music_v1' }, 'ElevenLabs-only'],
    ['musicLengthMs with google', { prompt: 'x', provider: 'google', musicLengthMs: 120000 }, 'ElevenLabs-only'],
    ['outputFormat with google', { prompt: 'x', provider: 'google', outputFormat: 'mp3_44100' }, 'ElevenLabs-only'],
    ['lyrics without google', { prompt: 'x', lyrics: '[Verse] hi' }, 'Google-only'],
    ['lyrics and instrumental together', { prompt: 'x', provider: 'google', lyrics: 'a', instrumental: true }, 'cannot both be set'],
    ['a non-string Lyria model', { prompt: 'x', provider: 'google', model: 42 }, 'non-empty string'],
  ]

  for (const [name, body, message] of cases) {
    test(`${name} → 400`, async () => {
      const res = await postMusic(body)
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain(message)
      expect(upstreamCalls).toHaveLength(0)
    })
  }

  test('an unknown Lyria model lists the models that exist', async () => {
    const res = await postMusic({ prompt: 'x', provider: 'google', model: 'lyria-9' })
    expect((await res.json()).allowed).toEqual(['lyria-3-clip', 'lyria-3.5'])
  })
})

// ─── AC5: upstream failures keep their status ─────────────────────────────

describe('upstream Lyria failures', () => {
  test('a Google rejection is a 502 carrying Google status and body', async () => {
    googleRespond = () => new Response('{"error":"quota"}', { status: 429 })

    const res = await postMusic({ prompt: 'x', provider: 'google' })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('Music generation failed')
    expect(body.detail).toContain('Google music error (429)')
    expect(body.googleStatus).toBe(429)
    expect(usageRows).toHaveLength(0)
  })

  test('a 200 with no audio block is a 502, not a silent empty file', async () => {
    googleRespond = () => lyriaResponse(null)

    const res = await postMusic({ prompt: 'x', provider: 'google' })

    expect(res.status).toBe(502)
    expect((await res.json()).detail).toContain('no audio')
    expect(usageRows).toHaveLength(0)
  })
})
