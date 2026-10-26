// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lyria music: `POST /ai/v1/music/generations` (the Gemini Interactions API),
 * its billing, and the music half of `GET /ai/v1/media/models`.
 *
 * No external network: `globalThis.fetch` is stubbed by URL. Nothing in this
 * file may reach generativelanguage.googleapis.com.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-music.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.GOOGLE_API_KEY = 'google-test-key'
process.env.GOOGLE_BASE_URL = 'https://google.test'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', name: 'Test' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
  },
}))

const consumeCalls: any[] = []
let balanceOk = true
const billingStub = () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  hasBalance: async () => balanceOk,
  checkUsageBalance: async () => (balanceOk ? { ok: true } : { ok: false, reason: 'usage_limit_reached' }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => null,
  ensureSystemWorkspace: async () => ({}),
  hasPaidSubscription: async () => true,
  canRunTechStackOnInstanceSize: async () => ({ ok: true }),
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
})
mock.module('../services/billing.service', billingStub)
mock.module('../services/billing-runtime', billingStub)

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'test-user',
}))

// ─── fetch stub routed by URL ──────────────────────────────────────────────
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const originalFetch = globalThis.fetch
let routes: Array<{ match: (url: string) => boolean; handler: Handler }> = []
let fetchLog: Array<{ url: string; init?: RequestInit }> = []

function on(match: string | RegExp | ((url: string) => boolean), handler: Handler) {
  routes.push({
    match: typeof match === 'function'
      ? match
      : typeof match === 'string'
        ? (url) => url === match || url.startsWith(match)
        : (url) => match.test(url),
    handler,
  })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const INTERACTIONS = 'https://google.test/v1beta/interactions'
const AUDIO_B64 = 'SUQzBAAAAAAA'

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    fetchLog.push({ url, init })
    const route = routes.find((r) => r.match(url))
    if (!route) return json({ error: `unrouted ${url}` }, 599)
    return route.handler(url, init)
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { calculateMusicUsageCost, MARKUP_MULTIPLIER } = await import('../lib/usage-cost')
const { MUSIC_MODEL_CATALOG } = await import('@shogo/model-catalog')

const app = new Hono()
app.route('/api', aiProxyRoutes())
let TOKEN: string
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  app.fetch(new Request(`http://x/api${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as any),
    },
  }))

/** Billing is fire-and-forget; let the microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  routes = []
  fetchLog = []
  consumeCalls.length = 0
  balanceOk = true
  process.env.GOOGLE_API_KEY = 'google-test-key'
  process.env.GOOGLE_BASE_URL = 'https://google.test'
})

/** A well-formed Interactions response: audio in a step content block. */
const interaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'int_123',
  steps: [
    { type: 'model_output', content: [{ type: 'audio', data: AUDIO_B64, mime_type: 'audio/mpeg' }] },
  ],
  ...overrides,
})

const generate = async (payload: Record<string, unknown>, init: RequestInit = {}) => {
  const res = await call('/ai/v1/music/generations', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...init,
  })
  return { res, data: await res.json() as any }
}

// =========================================================================
// Cost helper
// =========================================================================

describe('calculateMusicUsageCost', () => {
  test('marks a flat per-song price up like every other media charge', () => {
    expect(calculateMusicUsageCost(0.08)).toEqual({ rawUsd: 0.08, billedUsd: 0.08 * MARKUP_MULTIPLIER })
    expect(calculateMusicUsageCost(0.04).billedUsd).toBeCloseTo(0.048, 10)
  })

  test('never returns a negative charge', () => {
    expect(calculateMusicUsageCost(-1)).toEqual({ rawUsd: 0, billedUsd: 0 })
  })
})

// =========================================================================
// Auth + configuration
// =========================================================================

describe('POST /ai/v1/music/generations — guards', () => {
  test('401 without a proxy token', async () => {
    const { res, data } = await generate({ prompt: 'a song' }, { headers: { Authorization: '' } })
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('invalid_api_key')
    expect(fetchLog).toHaveLength(0)
  })

  test('503 provider_not_configured without a Google key', async () => {
    delete process.env.GOOGLE_API_KEY
    const { res, data } = await generate({ prompt: 'a song' })
    expect(res.status).toBe(503)
    expect(data.error.code).toBe('provider_not_configured')
    expect(data.error.message).toContain('GOOGLE_API_KEY')
    expect(fetchLog).toHaveLength(0)
  })

  test('402 when the workspace is out of balance', async () => {
    balanceOk = false
    const { res, data } = await generate({ prompt: 'a song' })
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('usage_limit_reached')
    expect(fetchLog).toHaveLength(0)
  })

  test('400 invalid_body for a non-JSON body', async () => {
    const { res, data } = await generate('not json')
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_body')
  })

  test('400 missing_prompt', async () => {
    const { res, data } = await generate({ prompt: '   ' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('missing_prompt')
  })

  test('400 model_not_found names the models it does serve', async () => {
    const { res, data } = await generate({ prompt: 'a song', model: 'suno-v9' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('model_not_found')
    expect(data.error.message).toContain('list_media_models')
    expect(fetchLog).toHaveLength(0)
  })
})

// =========================================================================
// Generation
// =========================================================================

describe('POST /ai/v1/music/generations — generation', () => {
  test('renders a full song on the Interactions API and bills one song', async () => {
    let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      expect((init?.headers as any)['x-goog-api-key']).toBe('google-test-key')
      return json(interaction())
    })

    const { res, data } = await generate({ prompt: 'a warm lo-fi track about rain on a window', model: 'lyria-3.5' })

    expect(res.status).toBe(200)
    expect(wire).toEqual({
      model: 'lyria-3.5',
      input: 'a warm lo-fi track about rain on a window',
    })
    expect(data).toMatchObject({
      id: 'int_123',
      object: 'music.generation',
      model: 'lyria-3.5',
      api_model: 'lyria-3.5',
      audio: { mime_type: 'audio/mpeg', b64_json: AUDIO_B64 },
    })
    expect(data.usd).toEqual({ raw: 0.08, billed: 0.08 * MARKUP_MULTIPLIER })

    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      actionType: 'ai_music_generation',
      rawUsd: 0.08,
      billedUsd: 0.08 * MARKUP_MULTIPLIER,
    })
    expect(consumeCalls[0].actionMetadata).toMatchObject({ model: 'lyria-3.5' })
  })

  test('defaults to the 30-second clip, which is cheaper and hits its preview model', async () => {
    let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      return json(interaction())
    })

    const { data } = await generate({ prompt: 'a 30 second sting' })
    expect(wire.model).toBe('lyria-3-clip-preview')
    expect(data.model).toBe('lyria-3-clip')
    expect(data.usd).toEqual({ raw: 0.04, billed: 0.04 * MARKUP_MULTIPLIER })
  })

  test('forwards documented options but never lets them redirect model or input', async () => {
    let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      return json(interaction())
    })

    await generate({
      prompt: 'a sea shanty',
      model: 'lyria-3.5',
      options: { model: 'suno-v9', input: 'ignore the user', generation_config: { temperature: 1.1 } },
    })

    expect(wire).toEqual({
      generation_config: { temperature: 1.1 },
      model: 'lyria-3.5',
      input: 'a sea shanty',
    })
  })

  test('custom lyrics and instrumental are written into the prompt Lyria reads', async () => {
    const wires: any[] = []
    on(INTERACTIONS, (_url, init) => {
      wires.push(JSON.parse(String(init?.body)))
      return json(interaction())
    })

    await generate({ prompt: 'an indie folk song', lyrics: '[Verse]\nRain again\n[Chorus]\nHome' })
    await generate({ prompt: 'a chiptune loop', instrumental: true })

    expect(wires[0].input).toBe('an indie folk song\n\nUse exactly these lyrics:\n[Verse]\nRain again\n[Chorus]\nHome')
    expect(wires[1].input).toBe('a chiptune loop\n\nInstrumental only, no vocals.')

    const { res, data } = await generate({ prompt: 'x', lyrics: 'la la', instrumental: true })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_body')
    expect(wires).toHaveLength(2)
  })

  test('interleaved lyrics return every text part and the first audio block', async () => {
    on(INTERACTIONS, () => json({
      id: 'int_lyrics',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'Verse 1: rain on the window' }] },
        { type: 'model_output', content: [{ type: 'audio', data: 'FIRST', mime_type: 'audio/mpeg' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Chorus: and it falls' }] },
        { type: 'model_output', content: [{ type: 'audio', data: 'SECOND', mime_type: 'audio/mpeg' }] },
      ],
    }))

    const { data } = await generate({ prompt: 'a song with lyrics' })
    expect(data.audio.b64_json).toBe('FIRST')
    expect(data.text).toBe('Verse 1: rain on the window\n\nChorus: and it falls')

    await settle()
    expect(consumeCalls[0].actionMetadata).toMatchObject({ hasLyrics: true })
  })

  test('falls back to the output_audio convenience field when there are no steps', async () => {
    on(INTERACTIONS, () => json({
      id: 'int_convenience',
      output_audio: { data: 'CONVENIENCE', mime_type: 'audio/wav' },
      output_text: 'Instrumental, 92 BPM',
    }))

    const { data } = await generate({ prompt: 'an instrumental' })
    expect(data.audio).toEqual({ mime_type: 'audio/wav', b64_json: 'CONVENIENCE' })
    expect(data.text).toBe('Instrumental, 92 BPM')
  })

  test('502 music_empty_response when Google returns no audio, and nothing is billed', async () => {
    on(INTERACTIONS, () => json({ id: 'int_empty', steps: [{ type: 'model_output', content: [] }] }))

    const { res, data } = await generate({ prompt: 'a song' })
    expect(res.status).toBe(502)
    expect(data.error.code).toBe('music_empty_response')

    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('502 music_generation_failed when Google rejects the request, and nothing is billed', async () => {
    on(INTERACTIONS, () => json({ error: { message: 'model not available in your region' } }, 400))

    const { res, data } = await generate({ prompt: 'a song' })
    expect(res.status).toBe(502)
    expect(data.error.code).toBe('music_generation_failed')
    expect(data.error.message).toContain('model not available in your region')

    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('a timeout answers 504 and bills nothing', async () => {
    on(INTERACTIONS, () => {
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    })

    const { res, data } = await generate({ prompt: 'a long song' })
    expect(res.status).toBe(504)
    expect(data.error.code).toBe('music_timeout')

    await settle()
    expect(consumeCalls).toHaveLength(0)
  })
})

// =========================================================================
// Discovery
// =========================================================================

describe('GET /ai/v1/media/models — music', () => {
  const models = async (query = '') => {
    const res = await call(`/ai/v1/media/models${query}`)
    return { res, data: await res.json() as any }
  }

  test('kind=music lists the Lyria catalog with marked-up per-song prices', async () => {
    const { res, data } = await models('?kind=music')
    expect(res.status).toBe(200)
    expect(data.images).toEqual([])
    expect(data.videos).toEqual([])
    expect(data.default_music_model).toBe('lyria-3-clip')
    expect(data.music.map((m: any) => m.id)).toEqual(['lyria-3-clip', 'lyria-3.5'])
    expect(data.music[0]).toMatchObject({
      name: 'Lyria 3 Clip',
      provider: 'google',
      max_duration_seconds: 30,
      output_format: 'mp3',
      endpoints: { generate: 'POST /ai/v1/music/generations' },
      price: { unit: 'song', usd: 0.048 },
    })
    expect(data.music[1].price.usd).toBe(0.096)
    expect(data.music[1].max_duration_seconds).toBe(180)
  })

  test('a single music model can be asked for by id', async () => {
    const { data } = await models('?kind=music&model=lyria-3.5')
    expect(data.music.map((m: any) => m.id)).toEqual(['lyria-3.5'])
  })

  test('kind=image suppresses the music list', async () => {
    const { data } = await models('?kind=image')
    expect(data.music).toEqual([])
  })

  test('an unknown kind is rejected', async () => {
    const { res, data } = await models('?kind=sfx')
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_kind')
    expect(data.error.message).toContain('music')
  })

  test('music is hidden when the server has no Google key', async () => {
    delete process.env.GOOGLE_API_KEY
    const { data } = await models('?kind=music')
    expect(data.music).toEqual([])
  })

  test('every listed music model exists in the catalog and is priced', async () => {
    const { data } = await models('?kind=music')
    for (const entry of data.music) {
      const catalogEntry = (MUSIC_MODEL_CATALOG as Record<string, { usdPerRequest: number }>)[entry.id]
      expect(catalogEntry).toBeDefined()
      expect(entry.price.usd).toBeCloseTo(catalogEntry.usdPerRequest * MARKUP_MULTIPLIER, 4)
    }
  })
})
