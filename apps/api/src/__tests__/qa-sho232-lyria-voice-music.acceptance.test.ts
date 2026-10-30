// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance — SHO-232: a Google key also drives Lyria music on
 * `POST /api/voice/music`.
 *
 * The dev-side tests cover the units with `fetch` stubbed. This file covers the
 * chain a user actually walks, with the two pieces a stub cannot prove:
 *
 *   - the request that really goes on the wire, observed by a **real HTTP
 *     server** standing in for Gemini (via `GOOGLE_BASE_URL`, set to the
 *     OpenAI-compat root a desktop is configured with), and
 *   - the key coming from the **real admin key store** (encrypted
 *     `PlatformSetting`, written by `PUT /provider-keys`), not just the env.
 *
 * Acceptance criteria exercised here:
 *   AC1  Google key + `provider: 'google'` → playable Lyria audio + a usage row
 *   AC2  no Google key → ElevenLabs still renders, and says why it fell back
 *   AC3  no `provider` → ElevenLabs only, response shape and errors unchanged
 *   AC4  desktop and cloud resolve the key the same way (no desktop-only path)
 *
 * AC5 (no new agent tool, no schema change) is structural: the diff adds no
 * `prisma/schema*.prisma` change and no tool registration, and this file
 * asserts the response is still raw audio bytes, not a new envelope.
 *
 *   bun test apps/api/src/__tests__/qa-sho232-lyria-voice-music.acceptance.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const PROJECT_ID = 'proj-qa-sho232'
const WORKSPACE_ID = 'ws-qa-sho232'
const OWNER_USER_ID = 'user-qa-sho232'
const ELEVENLABS_KEY = 'xi-qa-sho232-pooled'
const GOOGLE_KEY = 'AIza-qa-sho232-admin-entered-key'
const INTERNAL_API = 'http://internal-qa-sho232'

process.env.AI_PROXY_SECRET = 'qa-sho232-secret'
process.env.BETTER_AUTH_SECRET = 'qa-sho232-better-auth-secret'
// 32-byte master key so the admin route can encrypt the key at rest.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
// The whole point of the card: the key comes from the store, never the env.
delete process.env.GOOGLE_API_KEY
delete process.env.GOOGLE_BASE_URL
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY

// ─── In-memory prisma ─────────────────────────────────────────────────────

const projects = new Map([[PROJECT_ID, { id: PROJECT_ID, workspaceId: WORKSPACE_ID }]])
let settings: Map<string, { key: string; value: string }>
let usageRows: any[]

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
  platformSetting: {
    findMany: mock(async ({ where }: any = {}) => {
      const all = [...settings.values()]
      const prefix: string | undefined = where?.key?.startsWith
      return prefix ? all.filter((row) => row.key.startsWith(prefix)) : all
    }),
    findUnique: mock(async ({ where }: any) => settings.get(where.key) ?? null),
    upsert: mock(async ({ where, create, update }: any) => {
      const existing = settings.get(where.key)
      const row = existing ? { ...existing, ...update } : { ...create }
      settings.set(where.key, row)
      return row
    }),
    deleteMany: mock(async ({ where }: any = {}) => {
      const prefix: string | undefined = where?.key?.startsWith
      for (const key of [...settings.keys()]) {
        if (!prefix || key.startsWith(prefix)) settings.delete(key)
      }
      return { count: 0 }
    }),
  },
  user: { findUnique: mock(async () => null) },
  member: { findFirst: mock(async () => null), findMany: mock(async () => []) },
  workspace: { findUnique: mock(async () => null) },
}

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

const { Hono } = await import('hono')
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
const { voiceMediaRoutes } = await import('../routes/voice-media')
const { adminModelCatalogRoutes } = await import('../routes/admin-model-catalog')
const { invalidateProviderCredentials } = await import('../services/provider-credentials.service')

// ─── A real server standing in for Google ─────────────────────────────────

interface GoogleHit {
  path: string
  search: string
  apiKey: string | null
  body: any
}

let googleHits: GoogleHit[] = []
let googleServer: ReturnType<typeof Bun.serve>
let googleRespond: () => Response

const lyriaBytes = Buffer.from('ID3-lyria-qa-track-bytes')
const lyriaAudioB64 = lyriaBytes.toString('base64')

/** The Interactions response: audio arrives inline as a base64 block. */
function lyriaInteraction(audio: string | null = lyriaAudioB64): Response {
  return new Response(
    JSON.stringify({
      id: 'interaction-qa-sho232',
      steps: audio
        ? [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data: audio }] }]
        : [{ type: 'model_output', content: [{ type: 'text', text: 'no music for that prompt' }] }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// Only ElevenLabs is stubbed: it has no configurable base URL, and the point of
// this file is the Google leg, which goes over real HTTP below.
const realFetch = globalThis.fetch
let elevenLabsHits: Array<{ path: string; body: any }> = []
let otherHits: Array<{ url: string; body: any }> = []
const elevenLabsBytes = new Uint8Array([0xff, 0xf3, 0x40, 0x00, 0x51])

function installFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (url.startsWith('https://api.elevenlabs.io')) {
      elevenLabsHits.push({
        path: new URL(url).pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      })
      return new Response(elevenLabsBytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }
    // The fake Google server is a real listener; everything else (Shogo Cloud)
    // is recorded, never dialled.
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    otherHits.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    return new Response(JSON.stringify({ error: 'cloud_unreachable_in_qa' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

// ─── The app under test: real route, real auth ────────────────────────────

let app: Hono

function buildApp(): Hono {
  const hono = new Hono()
  hono.route('/api/admin/settings', adminModelCatalogRoutes())
  hono.use('/api/voice/*', authMiddleware)
  hono.route('/api', voiceMediaRoutes())
  return hono
}

function postMusic(body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://api.test/api/voice/music?projectId=${PROJECT_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-runtime-token': deriveRuntimeToken(PROJECT_ID),
      },
      body: JSON.stringify(body),
    }),
  )
}

async function storeGoogleKey(key: string | null): Promise<void> {
  const res = await app.fetch(
    new Request('http://api.test/api/admin/settings/provider-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google: key ?? '' }),
    }),
  )
  expect(res.status).toBe(200)
  // The credentials snapshot is module-level and cached for 30s.
  await invalidateProviderCredentials()
}

const googleCalls = () => googleHits.filter((hit) => hit.path.includes('interactions'))

beforeAll(() => {
  googleServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      googleHits.push({
        path: url.pathname,
        search: url.search,
        apiKey: req.headers.get('x-goog-api-key'),
        body: await req.json().catch(() => null),
      })
      return googleRespond()
    },
  })
  // A desktop configures GOOGLE_BASE_URL as the OpenAI-compat root (what chat
  // routing expects). Lyria must still land on the bare host's endpoint.
  process.env.GOOGLE_BASE_URL = `http://127.0.0.1:${googleServer.port}/v1beta/openai`
})

afterAll(() => {
  googleServer?.stop(true)
  globalThis.fetch = realFetch
  delete process.env.GOOGLE_BASE_URL
})

beforeEach(async () => {
  settings = new Map()
  usageRows = []
  googleHits = []
  elevenLabsHits = []
  otherHits = []
  googleRespond = () => lyriaInteraction()
  process.env.ELEVENLABS_API_KEY = ELEVENLABS_KEY
  process.env.RUNTIME_AUTH_SECRET = deriveRuntimeToken(PROJECT_ID)
  process.env.PROJECT_ID = PROJECT_ID
  process.env.SHOGO_API_URL = INTERNAL_API
  delete process.env.GOOGLE_API_KEY
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.SHOGO_API_KEY
  app = buildApp()
  installFetch()
  await invalidateProviderCredentials()
})

// ─── AC1 ──────────────────────────────────────────────────────────────────

describe('AC1: a configured Google key renders Lyria and meters the track', () => {
  test('the key entered in Admin → Models is what Lyria is called with, and the audio comes back as bytes', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'warm lofi piano loop, 80 bpm', provider: 'google' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-music-provider')).toBe('google')
    expect(res.headers.get('x-music-model')).toBe('lyria-3-clip')
    expect(Buffer.from(await res.arrayBuffer()).equals(lyriaBytes)).toBe(true)

    // The real wire request: the bare host, the Interactions endpoint, the
    // decrypted admin key, the model we bill for.
    expect(googleCalls()).toHaveLength(1)
    const call = googleCalls()[0]
    expect(call.path).toBe('/v1beta/interactions')
    expect(call.search).toBe('')
    expect(call.apiKey).toBe(GOOGLE_KEY)
    expect(call.body.model).toBe('lyria-3-clip-preview')
    expect(call.body.input).toContain('warm lofi piano loop, 80 bpm')

    // ElevenLabs is not touched at all on this path.
    expect(elevenLabsHits).toHaveLength(0)

    expect(usageRows).toHaveLength(1)
    expect(usageRows[0].actionMetadata).toMatchObject({
      opId: 'music',
      unit: 'second',
      provider: 'google',
      model: 'lyria-3-clip',
    })
    expect(usageRows[0].actionMetadata.units).toBe(30)
  })

  test('`model: lyria-3.5` is the model on the wire, in the header and in the usage row', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'a full synthwave song', provider: 'google', model: 'lyria-3.5' })

    expect(res.status).toBe(200)
    expect(googleCalls()[0].body.model).toBe('lyria-3.5')
    expect(res.headers.get('x-music-model')).toBe('lyria-3.5')
    expect(usageRows[0].actionMetadata.model).toBe('lyria-3.5')
    // A full song's length is prompt-controlled, so the row flags the seconds
    // as an assumption instead of presenting them as measured.
    expect(usageRows[0].actionMetadata.unitsEstimated).toBe(true)
  })

  test('a fixed-length track is metered as measured, not estimated', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'a short sting', provider: 'google' })

    expect(res.status).toBe(200)
    expect(usageRows[0].actionMetadata.units).toBe(30)
    expect(usageRows[0].actionMetadata.unitsEstimated).toBeUndefined()
  })

  test('a Google-only desktop needs no ElevenLabs key to render Lyria', async () => {
    delete process.env.ELEVENLABS_API_KEY
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'ambient pad', provider: 'google' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('google')
    expect(elevenLabsHits).toHaveLength(0)
  })

  test('an upstream Lyria rejection is a 502 that names Google and its status', async () => {
    await storeGoogleKey(GOOGLE_KEY)
    googleRespond = () => new Response('{"error":{"code":429,"message":"quota"}}', { status: 429 })

    const res = await postMusic({ prompt: 'x', provider: 'google' })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.googleStatus).toBe(429)
    expect(body.detail).toContain('Google music error (429)')
    // A failed render is not billed.
    expect(usageRows).toHaveLength(0)
  })
})

// ─── AC2 ──────────────────────────────────────────────────────────────────

describe('AC2: no Google key falls back to ElevenLabs and says why', () => {
  test('renders ElevenLabs Music and reports the reason instead of failing', async () => {
    const res = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('elevenlabs')
    expect(res.headers.get('warning')).toContain('no Google API key is configured')
    expect(googleHits).toHaveLength(0)
    expect(elevenLabsHits).toHaveLength(1)
    expect(elevenLabsHits[0].body.prompt).toBe('warm lofi piano loop')
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(elevenLabsBytes))).toBe(true)
  })

  test('with no provider key at all it is an honest 503, not a silent success', async () => {
    delete process.env.ELEVENLABS_API_KEY

    const res = await postMusic({ prompt: 'x', provider: 'google' })

    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('voice_unavailable')
    expect(googleHits).toHaveLength(0)
  })
})

// ─── AC3 ──────────────────────────────────────────────────────────────────

describe('AC3: ElevenLabs behaviour is unchanged when Google is not requested', () => {
  test('no `provider` means ElevenLabs, no warning, and the Google fields never reach it', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'warm lofi piano loop' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('elevenlabs')
    expect(res.headers.get('warning')).toBeNull()
    expect(googleHits).toHaveLength(0)

    const sent = elevenLabsHits[0].body
    expect(sent.prompt).toBe('warm lofi piano loop')
    // A routing/Google field leaking into ElevenLabs' body would 400 upstream.
    for (const key of ['provider', 'model', 'lyrics', 'instrumental']) {
      expect(sent).not.toHaveProperty(key)
    }
  })

  test('the old error semantics are untouched', async () => {
    const both = await postMusic({ prompt: 'lofi', compositionPlan: { sections: [] } })
    expect(both.status).toBe(400)
    expect((await both.json()).error).toContain('exactly one of')

    const missing = await postMusic({})
    expect(missing.status).toBe(400)

    expect(googleHits).toHaveLength(0)
    expect(elevenLabsHits).toHaveLength(0)
  })

  test('a cross-provider field is a 400 that names the field, not a silent drop', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'x', provider: 'google', outputFormat: 'mp3_44100_128' })

    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('outputFormat')
    expect(googleHits).toHaveLength(0)
  })

  test('a wrongly typed Google field is a 400, not a silent clip', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'x', provider: 'google', model: 42 })

    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('non-empty string')
    expect(googleHits).toHaveLength(0)
  })

  test('ElevenLabs still honours the length field that Google refuses', async () => {
    const res = await postMusic({ prompt: 'warm lofi piano loop', musicLengthMs: 120_000 })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-music-provider')).toBe('elevenlabs')
    expect(elevenLabsHits[0].body.music_length_ms).toBe(120_000)
    expect(googleHits).toHaveLength(0)
  })

  test('a length the Lyria call cannot honour is refused, not silently ignored', async () => {
    // `musicLengthMs` is part of this route's public body (VoiceMusicBody), but
    // Lyria takes its length from the model — so it joins the cross-provider
    // table instead of being dropped while the usage row still meters it.
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'x', provider: 'google', musicLengthMs: 120_000 })

    expect(res.status).toBe(400)
    const body = JSON.stringify(await res.json())
    expect(body).toContain('musicLengthMs')
    // The error has to say what to send instead, not just refuse.
    expect(body).toContain('lyria-3.5')
    expect(googleHits).toHaveLength(0)
    expect(usageRows).toHaveLength(0)
  })
})

// ─── AC4 ──────────────────────────────────────────────────────────────────

describe('AC4: desktop and cloud resolve the Google key the same way', () => {
  test('desktop (local mode, own keys) and cloud render the same Lyria track off the stored key', async () => {
    await storeGoogleKey(GOOGLE_KEY)

    const cloud = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })
    const cloudBytes = Buffer.from(await cloud.arrayBuffer())
    const cloudCall = googleCalls()[0]

    // Desktop with the user's own keys: local mode on, no cloud key, so the
    // route renders locally instead of relaying to Shogo Cloud.
    process.env.SHOGO_LOCAL_MODE = 'true'
    delete process.env.SHOGO_API_KEY
    googleHits = []
    await invalidateProviderCredentials()

    const desktop = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })
    const desktopBytes = Buffer.from(await desktop.arrayBuffer())

    expect(desktop.status).toBe(200)
    expect(desktop.headers.get('x-music-provider')).toBe('google')
    expect(desktopBytes.equals(cloudBytes)).toBe(true)

    // Same endpoint, same key, same model on both tracks.
    const desktopCall = googleCalls()[0]
    expect(desktopCall.path).toBe(cloudCall.path)
    expect(desktopCall.apiKey).toBe(cloudCall.apiKey)
    expect(desktopCall.body).toEqual(cloudCall.body)
  })

  test('a desktop that is signed in to cloud relays the request instead of rendering locally', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = 'shogo-cloud-linked-key'
    await storeGoogleKey(GOOGLE_KEY)

    const res = await postMusic({ prompt: 'warm lofi piano loop', provider: 'google' })

    // Cloud holds the keys and bills the workspace, so the request leaves this
    // machine with `provider` intact and nothing is rendered here.
    expect(googleHits).toHaveLength(0)
    expect(otherHits).toHaveLength(1)
    expect(otherHits[0].url).toContain('/voice/music')
    expect(otherHits[0].body.provider).toBe('google')
    expect(res.status).not.toBe(200)
  })
})
