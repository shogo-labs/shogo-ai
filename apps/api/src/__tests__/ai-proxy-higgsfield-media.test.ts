// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Higgsfield media: the submit→poll→bill lifecycle for images and video, the
 * Genjutsu edit flows (including the source-clip upload), presets, and the
 * error/refund rules that keep us from charging for a failed render.
 *
 * No external network: `globalThis.fetch` is stubbed by URL, and
 * `HIGGSFIELD_BASE_URL` points at a fake origin so the SSRF guard is exercised
 * for real.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-higgsfield-media.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.HIGGSFIELD_API_KEY = 'hf-test-key'
process.env.HIGGSFIELD_BASE_URL = 'https://hf.test'
delete process.env.FAL_KEY

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
const billingStub = () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
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

function on(match: string | RegExp, handler: Handler) {
  routes.push({
    match: (url) => (typeof match === 'string' ? url === match || url.startsWith(match) : match.test(url)),
    handler,
  })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
const mp4 = () => new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'Content-Type': 'video/mp4' } })

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
beforeEach(() => {
  routes = []
  fetchLog = []
  consumeCalls.length = 0
})

const { Hono } = await import('hono')
const { aiProxyRoutes, listMediaModels, _resetHiggsfieldEstimateCache } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const {
  buildHiggsfieldImageRequest,
  buildHiggsfieldVideoRequest,
  nearestHiggsfieldAspectRatio,
  parseHiggsfieldEstimate,
  formatHiggsfieldError,
  assertHiggsfieldUrl,
  HIGGSFIELD_POLL,
} = await import('../lib/higgsfield-media')
// Poll immediately: the mock answers on the first call, and 2 s waits would
// make this suite minutes long for no extra coverage.
HIGGSFIELD_POLL.initialMs = 1
HIGGSFIELD_POLL.maxMs = 1
const { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } = await import('@shogo/model-catalog')
const { _testing: videoStore } = await import('../lib/video-job-store')

const app = new Hono()
app.route('/api', aiProxyRoutes())
let TOKEN: string
let OTHER_WS_TOKEN: string
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
  OTHER_WS_TOKEN = await generateProxyToken('proj-2', 'ws-2', 'user-2')
})

const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
  app.fetch(new Request(`http://x/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as any) },
  }))

/** Billing is fire-and-forget; let the microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

const SUBMIT_URL = 'https://hf.test/higgsfield-ai/soul/v2/standard'
const STATUS_PREFIX = 'https://hf.test/requests/'

/**
 * Mock one submit→status cycle. `states` is the sequence of statuses the poll
 * sees; the last one repeats.
 */
function mockGeneration(opts: {
  endpoint: string
  states?: string[]
  imageUrls?: string[]
  videoUrl?: string
  error?: string
}) {
  const states = opts.states ?? ['completed']
  let poll = 0
  on(`https://hf.test/${opts.endpoint}`, () => json({
    request_id: 'req-1',
    status: 'queued',
    status_url: `${STATUS_PREFIX}req-1/status`,
    cancel_url: `${STATUS_PREFIX}req-1/cancel`,
  }))
  on(`${STATUS_PREFIX}req-1/status`, () => {
    const status = states[Math.min(poll++, states.length - 1)]
    return json({
      status,
      request_id: 'req-1',
      ...(status === 'completed'
        ? { ...(opts.videoUrl ? { video: { url: opts.videoUrl } } : {}), ...(opts.imageUrls ? { images: opts.imageUrls.map((url) => ({ url })) } : {}) }
        : {}),
      ...(opts.error ? { error: opts.error } : {}),
    })
  })
}

function mockEstimate(endpoint: string, usd = '0.0700', credits = '1.500') {
  on(`https://hf.test/estimate/${endpoint}`, () => json({ credits, usd }))
}

// =========================================================================
// Pure helpers
// =========================================================================

describe('helpers', () => {
  test('estimate numbers arrive as strings and parse to USD', () => {
    expect(parseHiggsfieldEstimate({ credits: '1.500', usd: '0.0940' })).toEqual({ rawUsd: 0.094, credits: 1.5 })
    expect(parseHiggsfieldEstimate({ credits: '1.5' })).toBeNull()
    expect(parseHiggsfieldEstimate({ usd: 'not-a-number' })).toBeNull()
  })

  test('a fastapi validation envelope becomes a readable message', () => {
    const { message, code } = formatHiggsfieldError(422, {
      detail: [{ loc: ['body', 'duration'], msg: 'value is not a valid enumeration member', type: 'enum' }],
    })
    expect(code).toBe('validation')
    expect(message).toContain('body.duration')
    expect(message).toContain('not a valid enumeration member')
  })

  test('400 + concurrency wording is the account limit, not a bad parameter', () => {
    const { code, message } = formatHiggsfieldError(400, { detail: 'Maximum number of concurrent requests reached' })
    expect(code).toBe('provider_busy')
    expect(message).toContain('retry in a moment')
  })

  test('403 is insufficient credits', () => {
    expect(formatHiggsfieldError(403, { detail: 'not enough credits' }).code).toBe('credits')
  })

  test('refuses to poll a foreign host', () => {
    expect(() => assertHiggsfieldUrl('https://evil.test/requests/1/status')).toThrow()
    expect(() => assertHiggsfieldUrl('https://hf.test/requests/1/status')).not.toThrow()
  })

  test('sizes snap to the nearest ratio the model accepts', () => {
    const soul = ['1:1', '9:16', '16:9', '4:3', '3:4']
    expect(nearestHiggsfieldAspectRatio('1024x1792', soul)).toBe('9:16')
    expect(nearestHiggsfieldAspectRatio('1792x1024', soul)).toBe('16:9')
    expect(nearestHiggsfieldAspectRatio('1024x1024', soul)).toBe('1:1')
    expect(nearestHiggsfieldAspectRatio(undefined, soul)).toBe('1:1')
  })

  test('soul image request carries only documented fields', () => {
    const req = buildHiggsfieldImageRequest(IMAGE_MODEL_CATALOG['hf-soul-v2'] as any, {
      prompt: 'a can', size: '1024x1792', quality: 'hd',
    })
    expect(req.endpoint).toBe('higgsfield-ai/soul/v2/standard')
    expect(req.input).toEqual({
      prompt: 'a can',
      aspect_ratio: '9:16',
      resolution: '1080p',
      enhance_prompt: false,
      batch_size: 1,
    })
  })

  // ---- per-family image request table ----------------------------------
  const shape = (id: string, params: any) =>
    buildHiggsfieldImageRequest((IMAGE_MODEL_CATALOG as any)[id], { prompt: 'a can', ...params })

  test('every Higgsfield image catalog entry builds a request and never throws', () => {
    const entries = Object.values(IMAGE_MODEL_CATALOG).filter((e: any) => e.provider === 'higgsfield')
    expect(entries.length).toBe(15)
    for (const entry of entries as any[]) {
      const withRefs = shape(entry.id, { referenceUrls: ['https://cdn.test/a.png'] })
      expect(withRefs.endpoint).toBeTruthy()
      expect(withRefs.input.prompt).toBe('a can')
      expect(() => shape(entry.id, { size: '1792x1024', quality: 'max' })).not.toThrow()
    }
  })

  test('SOUL standard takes one style reference on image_reference_url', () => {
    const req = shape('hf-soul-standard', { quality: 'standard', size: '1024x1024', referenceUrls: ['https://cdn.test/a.png', 'https://cdn.test/b.png'] })
    expect(req.endpoint).toBe('higgsfield-ai/soul/standard')
    expect(req.input).toMatchObject({ resolution: '720p', enhance_prompt: false, image_reference_url: 'https://cdn.test/a.png' })
  })

  test('Qwen switches to the edit endpoint only when references are present', () => {
    const t2i = shape('hf-qwen-image-3', { quality: 'hd' })
    expect(t2i.endpoint).toBe('alibaba/qwen-image-3/text-to-image')
    expect(t2i.input).toMatchObject({ resolution: '2k', aspect_ratio: '1:1' })
    expect(t2i.input.image_urls).toBeUndefined()

    const edit = shape('hf-qwen-image-3', { referenceUrls: ['https://cdn.test/a.png', 'https://cdn.test/b.png'] })
    expect(edit.endpoint).toBe('alibaba/qwen-image-3/edit')
    expect(edit.input.image_urls).toEqual(['https://cdn.test/a.png', 'https://cdn.test/b.png'])
  })

  test('Recraft sends the resolution its variant is fixed at', () => {
    expect(shape('hf-recraft-v4.1', { quality: 'hd' }).input).toMatchObject({ resolution: '1k', aspect_ratio: '1:1' })
    expect(shape('hf-recraft-v4.1-pro', { quality: 'standard' }).input).toMatchObject({ resolution: '2k' })
    expect(shape('hf-recraft-v4.1-utility-pro', { quality: 'standard' }).input).toMatchObject({ resolution: '2k' })
    // 14 documented ratios, including the ones only Recraft accepts.
    expect(shape('hf-recraft-v4.1', { size: '1400x1000' }).input.aspect_ratio).toBe('14:10')
  })

  test('Z-Image accepts the wide 21:9 ratio', () => {
    expect(shape('hf-z-image-turbo', { size: '2520x1080' }).input).toMatchObject({ aspect_ratio: '21:9', resolution: '1k' })
  })

  test('Marketing Studio maps standard→medium/1k and hd→high/2k, and passes xhigh through', () => {
    expect(shape('hf-marketing-studio', { quality: 'standard' }).input).toMatchObject({ quality: 'medium', resolution: '1k' })
    expect(shape('hf-marketing-studio', { quality: 'hd' }).input).toMatchObject({ quality: 'high', resolution: '2k' })
    expect(shape('hf-marketing-studio-flare', { quality: 'xhigh' }).input).toMatchObject({ quality: 'xhigh' })
    // 2.0 Alpha only takes low/medium/high, so xhigh is not forwarded there.
    expect(shape('hf-marketing-studio', { quality: 'xhigh' }).input).toMatchObject({ quality: 'high' })
  })

  test('Grok sends medium for both tiers — it has no high', () => {
    expect(shape('hf-grok-image-2', { quality: 'standard' }).input).toMatchObject({ quality: 'medium', resolution: '1k' })
    expect(shape('hf-grok-image-2', { quality: 'hd' }).input).toMatchObject({ quality: 'medium', resolution: '2k' })
  })

  test('Ads Studio sends the prompt, ratio and references only', () => {
    const req = shape('hf-ads-studio', { size: '1080x1350', referenceUrls: ['https://cdn.test/product.png'] })
    expect(req.endpoint).toBe('higgsfield/ads-studio/v1.0')
    expect(req.input).toEqual({
      prompt: 'a can',
      aspect_ratio: '4:5',
      image_urls: ['https://cdn.test/product.png'],
    })
  })

  test('hailuo text-to-video sends duration only; image-to-video switches endpoint', () => {
    const entry = VIDEO_MODEL_CATALOG['hf-hailuo-2.3'] as any
    const t2v = buildHiggsfieldVideoRequest(entry, { prompt: 'waves', duration: 10 })
    expect(t2v.endpoint).toBe('minimax/hailuo-2.3/standard/text-to-video')
    expect(t2v.input).toEqual({ prompt: 'waves', duration: 10 })

    const i2v = buildHiggsfieldVideoRequest(entry, { prompt: 'waves', duration: 6, startImageUrl: 'https://cdn.test/first.png' })
    expect(i2v.endpoint).toBe('minimax/hailuo-2.3/standard/image-to-video')
    expect(i2v.input.image_url).toBe('https://cdn.test/first.png')
  })

  test('ltx is the one text-to-video that takes an aspect ratio and resolution', () => {
    const req = buildHiggsfieldVideoRequest(VIDEO_MODEL_CATALOG['hf-ltx-2.5-fast'] as any, {
      prompt: 'ad', duration: 8, aspectRatio: '9:16', resolution: '1080p',
    })
    expect(req.input).toMatchObject({ duration: 8, aspect_ratio: '9:16', resolution: '1080p' })
  })

  test('genjutsu restyle requires both a source clip and a preset', () => {
    const entry = VIDEO_MODEL_CATALOG['hf-genjutsu-restyle'] as any
    expect(() => buildHiggsfieldVideoRequest(entry, { prompt: 'x' })).toThrow(/source video/i)
    expect(() => buildHiggsfieldVideoRequest(entry, { sourceVideoUrl: 'https://cdn.test/in.mp4' })).toThrow(/preset_id/i)
    const ok = buildHiggsfieldVideoRequest(entry, {
      sourceVideoUrl: 'https://cdn.test/in.mp4', presetId: 'preset-1', referenceUrls: ['https://cdn.test/ref.png'], resolution: '480p',
    })
    expect(ok.endpoint).toBe('higgsfield/genjutsu/restyle/v1.0')
    expect(ok.input).toMatchObject({ video_url: 'https://cdn.test/in.mp4', preset_id: 'preset-1', resolution: '480p' })
  })
})

// =========================================================================
// Image generation: submit, poll, download, bill the estimate
// =========================================================================

describe('image generation', () => {
  test('polls to completion, returns base64, and bills the estimate with markup', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0940')
    mockGeneration({ endpoint: 'higgsfield-ai/soul/v2/standard', states: ['queued', 'in_progress', 'completed'], imageUrls: ['https://cdn.test/out.png'] })
    on('https://cdn.test/out.png', png)

    const res = await call('/ai/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a red can', size: '1024x1024' }),
    })
    const data = await res.json() as any
    expect(res.status).toBe(200)
    expect(data.data).toHaveLength(1)
    expect(typeof data.data[0].b64_json).toBe('string')
    expect(Buffer.from(data.data[0].b64_json, 'base64')).toEqual(Buffer.from([137, 80, 78, 71]))

    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('ai_image_generation')
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.094, 5)
    expect(consumeCalls[0].billedUsd).toBeCloseTo(0.094 * 1.2, 5)
  })

  test('an nsfw image is refused and never charged', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0940')
    mockGeneration({ endpoint: 'higgsfield-ai/soul/v2/standard', states: ['nsfw'] })

    const res = await call('/ai/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'blocked', model: 'hf-soul-v2' }),
    })
    const data = await res.json() as any
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('content filter')

    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('n images submit n requests and bill n estimates', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0100')
    mockGeneration({ endpoint: 'higgsfield-ai/soul/v2/standard', imageUrls: ['https://cdn.test/a.png'] })
    on('https://cdn.test/a.png', png)

    const res = await call('/ai/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'three cans', model: 'hf-soul-v2', n: 3 }),
    })
    expect(res.status).toBe(200)
    const submits = fetchLog.filter((f) => f.url === SUBMIT_URL && f.init?.method === 'POST')
    expect(submits).toHaveLength(3)
    // Distinct idempotency keys, so a retry can never dedupe two of the three.
    const keys = submits.map((s) => (s.init?.headers as any)['Idempotency-Key'])
    expect(new Set(keys).size).toBe(3)

    await settle()
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.03, 5)
  })

  test('a concurrency 400 surfaces as 429 so the caller backs off', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0040')
    on(SUBMIT_URL, () => json({ detail: 'Maximum number of concurrent requests' }, 400))

    const res = await call('/ai/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'x', model: 'hf-soul-v2' }),
    })
    const data = await res.json() as any
    expect(res.status).toBe(429)
    expect(data.error.code).toBe('provider_busy')
  })
})

// =========================================================================
// Image edits: data URIs get uploaded to a public URL first
// =========================================================================

describe('image edits', () => {
  test('uploads the reference and sends image_url to ideogram', async () => {
    on('https://hf.test/files/generate-upload-url', () => json({
      public_url: 'https://cdn.test/ref.png',
      upload_url: 'https://s3.test/put',
      upload_headers: { 'x-amz-tagging': 'expires=7d' },
    }))
    on('https://s3.test/put', () => new Response('', { status: 200 }))
    mockEstimate('ideogram/v4.0', '0.0600')
    mockGeneration({ endpoint: 'ideogram/v4.0', imageUrls: ['https://cdn.test/edited.png'] })
    on('https://cdn.test/edited.png', png)

    // The edits route is OpenAI-shaped: multipart, not JSON.
    const form = new FormData()
    form.set('prompt', 'same can, new label')
    form.set('model', 'hf-ideogram-4')
    form.set('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'ref.png')
    const res = await app.fetch(new Request('http://x/api/ai/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    }))
    expect(res.status).toBe(200)

    const put = fetchLog.find((f) => f.url === 'https://s3.test/put')
    expect(put).toBeDefined()
    // The retention header must survive, and the API key must never reach storage.
    expect((put!.init?.headers as any)['x-amz-tagging']).toBe('expires=7d')
    expect(JSON.stringify(put!.init?.headers ?? {})).not.toContain('hf-test-key')

    const submit = fetchLog.find((f) => f.url === 'https://hf.test/ideogram/v4.0')
    expect(JSON.parse(String(submit!.init?.body)).image_url).toBe('https://cdn.test/ref.png')
  })
})

// =========================================================================
// Source-clip upload (Genjutsu)
// =========================================================================

describe('media uploads', () => {
  test('rejects a content type the provider does not accept', async () => {
    const res = await call('/ai/v1/media/uploads', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'Content-Type': 'video/quicktime' },
    })
    const data = await res.json() as any
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('unsupported_content_type')
  })

  test('uploads video/mp4 and returns the public URL', async () => {
    on('https://hf.test/files/generate-upload-url', () => json({
      public_url: 'https://cdn.test/in.mp4',
      upload_url: 'https://s3.test/put-video',
      upload_headers: { 'x-amz-tagging': 'expires=7d' },
    }))
    on('https://s3.test/put-video', () => new Response('', { status: 200 }))

    const res = await call('/ai/v1/media/uploads', {
      method: 'POST',
      body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      headers: { 'Content-Type': 'video/mp4' },
    })
    const data = await res.json() as any
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ url: 'https://cdn.test/in.mp4', content_type: 'video/mp4' })
  })

  test('refuses a body over the 200 MB provider limit', async () => {
    const res = await call('/ai/v1/media/uploads', {
      method: 'POST',
      body: new Uint8Array([1]),
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(201 * 1024 * 1024) },
    })
    const data = await res.json() as any
    expect(res.status).toBe(413)
    expect(data.error.code).toBe('upload_too_large')
  })

  test('401 without auth', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/media/uploads', { method: 'POST', body: new Uint8Array([1]) }))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Presets
// =========================================================================

describe('presets', () => {
  test('lists restyle presets', async () => {
    on('https://hf.test/models/higgsfield/genjutsu/restyle/v1.0/presets', () =>
      json({ items: [{ id: 'preset-1', name: 'Anime', preview_url: 'https://cdn.test/p1.png' }] }))
    const res = await call('/ai/v1/media/presets')
    const data = await res.json() as any
    expect(res.status).toBe(200)
    expect(data.presets).toEqual([{ id: 'preset-1', name: 'Anime', previewUrl: 'https://cdn.test/p1.png' }])
  })
})

// =========================================================================
// Video routes
// =========================================================================

describe('video routes', () => {
  beforeEach(() => {
    videoStore.records.clear()
    videoStore.charged.clear()
  })

  async function submit(extra: Record<string, unknown> = {}) {
    const res = await call('/ai/v1/videos/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a fox runs', ...extra }),
    })
    return { res, data: await res.json() as any }
  }

  test('defaults to the cheapest Higgsfield model, captures the estimate, charges nothing yet', async () => {
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')
    mockGeneration({ endpoint: 'minimax/hailuo-2.3/standard/text-to-video', videoUrl: 'https://cdn.test/out.mp4' })

    const { res, data } = await submit()
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ status: 'queued', model: 'hf-hailuo-2.3', provider: 'higgsfield', price_source: 'estimate' })
    expect(data.id).toStartWith('vid_')
    expect(data.estimated_usd).toBeCloseTo(0.07 * 1.2, 4)
    expect(consumeCalls).toHaveLength(0)

    const submitCall = fetchLog.find((f) => f.url === 'https://hf.test/minimax/hailuo-2.3/standard/text-to-video')
    expect(JSON.parse(String(submitCall!.init?.body))).toEqual({ prompt: 'a fox runs', duration: 6 })
    // The minted job id is the idempotency key, so a retried submit cannot double-charge.
    expect((submitCall!.init?.headers as any)['Idempotency-Key']).toBe(data.id)
  })

  test('a completed job bills the captured estimate exactly once across polls', async () => {
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')
    mockGeneration({ endpoint: 'minimax/hailuo-2.3/standard/text-to-video', videoUrl: 'https://cdn.test/out.mp4' })

    const { data } = await submit()
    for (let i = 0; i < 3; i++) {
      const res = await call(`/ai/v1/videos/${data.id}`)
      const status = await res.json() as any
      expect(status.status).toBe('completed')
      expect(status.video.url).toBe('https://cdn.test/out.mp4')
    }
    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.07, 5)
    expect(consumeCalls[0].billedUsd).toBeCloseTo(0.084, 5)
    expect(consumeCalls[0].actionMetadata).toMatchObject({ provider: 'higgsfield', priceSource: 'estimate' })
  })

  test('an nsfw / failed job is reported failed and never charged', async () => {
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')
    mockGeneration({
      endpoint: 'minimax/hailuo-2.3/standard/text-to-video',
      states: ['nsfw'],
      error: 'blocked by content policy',
    })

    const { data } = await submit()
    const res = await call(`/ai/v1/videos/${data.id}`)
    const status = await res.json() as any
    expect(status.status).toBe('failed')
    expect(status.error).toContain('content policy')
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('a failed estimate refuses the job instead of running it unpriced', async () => {
    on('https://hf.test/estimate/minimax/hailuo-2.3/standard/text-to-video', () => json({ detail: 'nope' }, 500))

    const { res, data } = await submit()
    expect(res.status).toBe(503)
    expect(data.error.code).toBe('estimate_unavailable')
    // Nothing was submitted, so nothing can be billed.
    expect(fetchLog.some((f) => f.url === 'https://hf.test/minimax/hailuo-2.3/standard/text-to-video' && f.init?.method === 'POST')).toBe(false)
  })

  test('rejects an aspect_ratio on a model that has none', async () => {
    const { res, data } = await submit({ aspect_ratio: '9:16' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_aspect_ratio')
    expect(data.error.message).toContain('follows the start image')
  })

  test('rejects a resolution the model does not have', async () => {
    const { res, data } = await submit({ model: 'hf-kling-2.5-pro', resolution: '480p' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_resolution')
  })

  test('image-to-video uploads the start frame and switches endpoint', async () => {
    on('https://hf.test/files/generate-upload-url', () => json({
      public_url: 'https://cdn.test/first.png', upload_url: 'https://s3.test/put', upload_headers: {},
    }))
    on('https://s3.test/put', () => new Response('', { status: 200 }))
    mockEstimate('minimax/hailuo-2.3/standard/image-to-video', '0.0700')
    mockGeneration({ endpoint: 'minimax/hailuo-2.3/standard/image-to-video', videoUrl: 'https://cdn.test/out.mp4' })

    const start = `data:image/png;base64,${Buffer.from('first-frame').toString('base64')}`
    const { res } = await submit({ start_image: start, duration: 6 })
    expect(res.status).toBe(200)
    const submitCall = fetchLog.find((f) => f.url === 'https://hf.test/minimax/hailuo-2.3/standard/image-to-video')
    expect(JSON.parse(String(submitCall!.init?.body)).image_url).toBe('https://cdn.test/first.png')
  })

  test('genjutsu motion transfer needs a source clip, its length, and a reference', async () => {
    const missingSource = await submit({ genjutsu: 'motion_transfer' } as any)
    expect(missingSource.res.status).toBe(400)
    expect(missingSource.data.error.code).toBe('missing_source_video')

    const missingDuration = await submit({
      model: 'hf-genjutsu-motion-transfer',
      source_video_url: 'https://cdn.test/in.mp4',
    })
    expect(missingDuration.res.status).toBe(400)
    expect(missingDuration.data.error.code).toBe('missing_source_duration')

    const missingRef = await submit({
      model: 'hf-genjutsu-motion-transfer',
      source_video_url: 'https://cdn.test/in.mp4',
      source_duration_seconds: 8,
    })
    expect(missingRef.res.status).toBe(400)
    expect(missingRef.data.error.code).toBe('missing_reference_images')

    const tooShort = await submit({
      model: 'hf-genjutsu-motion-transfer',
      source_video_url: 'https://cdn.test/in.mp4',
      source_duration_seconds: 2,
      reference_images: [`data:image/png;base64,${Buffer.from('ref').toString('base64')}`],
    })
    expect(tooShort.res.status).toBe(400)
    expect(tooShort.data.error.code).toBe('source_too_short')
  })

  test('genjutsu restyle requires a preset_id', async () => {
    const { res, data } = await submit({
      model: 'hf-genjutsu-restyle',
      source_video_url: 'https://cdn.test/in.mp4',
      source_duration_seconds: 8,
      duration: undefined,
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('missing_preset_id')
  })

  test('a genjutsu edit bills the source-second rate card, not a flat clip price', async () => {
    on('https://hf.test/files/generate-upload-url', () => json({
      public_url: 'https://cdn.test/ref.png', upload_url: 'https://s3.test/put', upload_headers: {},
    }))
    on('https://s3.test/put', () => new Response('', { status: 200 }))
    mockGeneration({ endpoint: 'higgsfield/genjutsu/restyle/v1.0', videoUrl: 'https://cdn.test/out.mp4' })

    const ref = `data:image/png;base64,${Buffer.from('style-ref').toString('base64')}`
    const { res, data } = await submit({
      model: 'hf-genjutsu-restyle',
      prompt: undefined,
      source_video_url: 'https://cdn.test/in.mp4',
      source_duration_seconds: 8,
      preset_id: 'preset-1',
      resolution: '480p',
      reference_images: [ref],
    })
    expect(res.status).toBe(200)
    // 8 s at $0.318/s = $2.544 raw, marked up 1.2×.
    expect(data.estimated_usd).toBeCloseTo(0.318 * 8 * 1.2, 4)
    expect(data.price_source).toBe('rate_card')
    expect(data.duration).toBe(8)

    // Genjutsu quotes prose, not a `usd` figure, so no /estimate call is made.
    expect(fetchLog.some((f) => f.url.startsWith('https://hf.test/estimate/'))).toBe(false)

    const submitCall = fetchLog.find((f) => f.url === 'https://hf.test/higgsfield/genjutsu/restyle/v1.0')
    expect(JSON.parse(String(submitCall!.init?.body))).toEqual({
      video_url: 'https://cdn.test/in.mp4',
      image_urls: ['https://cdn.test/ref.png'],
      preset_id: 'preset-1',
      resolution: '480p',
    })

    const statusRes = await call(`/ai/v1/videos/${data.id}`)
    expect((await statusRes.json() as any).status).toBe('completed')
    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.318 * 8, 4)
    expect(consumeCalls[0].billedUsd).toBeCloseTo(0.318 * 8 * 1.2, 4)
  })
})

describe('estimate route', () => {
  beforeEach(() => _resetHiggsfieldEstimateCache())

  test('prices a Higgsfield clip without submitting anything', async () => {
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')
    const res = await call('/ai/v1/media/estimate', {
      method: 'POST',
      body: JSON.stringify({ model: 'hf-hailuo-2.3', duration: 10 }),
    })
    const data = await res.json() as any
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ provider: 'higgsfield', unit: 'clip', source: 'estimate' })
    expect(data.usd).toBeCloseTo(0.084, 4)
    expect(fetchLog.some((f) => f.url === 'https://hf.test/minimax/hailuo-2.3/standard/text-to-video')).toBe(false)

    // The vendor's schema requires a prompt even to quote a price; sending
    // none is what broke this route the first time.
    const estimateCall = fetchLog.find((f) => f.url.startsWith('https://hf.test/estimate/minimax/hailuo-2.3'))
    const sent = JSON.parse(String(estimateCall!.init?.body))
    expect(typeof sent.prompt).toBe('string')
    expect(sent.prompt.length).toBeGreaterThan(0)
    expect(sent.duration).toBe(10)
  })

  test('prices a fal model from the catalog, and a Genjutsu edit needs a length', async () => {
    const fal = await call('/ai/v1/media/estimate', {
      method: 'POST',
      body: JSON.stringify({ model: 'kling-3-pro', duration: 5 }),
    })
    // No FAL_KEY here, so the provider is not configured.
    expect(fal.status).toBe(503)

    const genjutsu = await call('/ai/v1/media/estimate', {
      method: 'POST',
      body: JSON.stringify({ model: 'hf-genjutsu-restyle' }),
    })
    const data = await genjutsu.json() as any
    expect(genjutsu.status).toBe(400)
    expect(data.error.code).toBe('missing_source_duration')
  })

  test('a token-priced endpoint is refused with a clear message, never a generic error', async () => {
    // Marketing Studio 2.5 Flare / Sunburst and Ads Studio answer with a rate
    // card instead of a `usd`.
    on('https://hf.test/estimate/marketing-studio/image/flare', () => json({
      type: 'description',
      pricing_description: 'Per 1M tokens: … image output $30.',
    }))
    const res = await call('/ai/v1/media/estimate', {
      method: 'POST',
      body: JSON.stringify({ model: 'hf-marketing-studio-flare' }),
    })
    const data = await res.json() as any
    expect(res.status).toBe(503)
    expect(data.error.message).toContain('per token')
  })

  test('prices an OpenAI image off the quality × size ladder', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    try {
      const res = await call('/ai/v1/media/estimate', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-image-2.5-flare', quality: 'hd', size: '1024x1536' }),
      })
      const data = await res.json() as any
      expect(res.status).toBe(200)
      expect(data.unit).toBe('image')
      // High portrait on the flare ladder: $0.165 raw, marked up 1.2×.
      expect(data.raw_usd).toBeCloseTo(0.165, 4)
      expect(data.usd).toBeCloseTo(0.198, 4)

      const medium = await call('/ai/v1/media/estimate', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-image-1', quality: 'standard', size: '1024x1024' }),
      })
      const mediumData = await medium.json() as any
      expect(mediumData.raw_usd).toBeCloseTo(0.042, 4)
      expect(mediumData.usd).toBeCloseTo(0.0504, 4)
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })

  test('Genjutsu prices off the source-second rate card', async () => {
    const at = async (resolution: string, seconds: number) => {
      const res = await call('/ai/v1/media/estimate', {
        method: 'POST',
        body: JSON.stringify({ model: 'hf-genjutsu-motion-transfer', source_duration_seconds: seconds, resolution }),
      })
      expect(res.status).toBe(200)
      return await res.json() as any
    }

    const draft = await at('480p', 4)
    expect(draft).toMatchObject({ unit: 'second', duration: 4, resolution: '480p', source: 'rate_card' })
    expect(draft.usd).toBeCloseTo(0.318 * 4 * 1.2, 3)

    const hero = await at('1080p', 8)
    expect(hero.usd).toBeCloseTo(1.632 * 8 * 1.2, 2)

    // The provider trims anything over 30 s, so 45 s bills as 30 s.
    const trimmed = await at('720p', 45)
    expect(trimmed.duration).toBe(30)
    expect(trimmed.usd).toBeCloseTo(0.681 * 30 * 1.2, 2)
  })

  test('an unknown model is a clear 400', async () => {
    const res = await call('/ai/v1/media/estimate', {
      method: 'POST',
      body: JSON.stringify({ model: 'not-a-model' }),
    })
    const data = await res.json() as any
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('model_not_found')
  })
})

// =========================================================================
// Listing
// =========================================================================

describe('list_media_models', () => {
  beforeEach(() => _resetHiggsfieldEstimateCache())

  test('lists Higgsfield first with per-clip prices and deprecated fal models flagged', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0940')
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')

    const data = await listMediaModels() as any
    expect(data.default_image_model).toBe('hf-soul-v2')
    expect(data.default_video_model).toBe('hf-hailuo-2.3')

    expect(data.images[0].id).toBe('hf-soul-v2')
    expect(data.images[0].provider).toBe('higgsfield')
    expect(data.videos[0].id).toBe('hf-hailuo-2.3')

    const hailuo = data.videos.find((m: any) => m.id === 'hf-hailuo-2.3')
    expect(hailuo.price.unit).toBe('clip')
    expect(hailuo.price.usd).toBeCloseTo(0.07 * 1.2, 4)
    expect(hailuo.price.source).toBe('estimate')

    // Genjutsu bills per source second, so it lists a rate, not a clip total.
    const restyle = data.videos.find((m: any) => m.id === 'hf-genjutsu-restyle')
    expect(restyle.price.unit).toBe('second')
    expect(restyle.price.usd).toBeCloseTo(0.681 * 1.2, 3)
    expect(restyle.price.by_resolution['480p']).toBeCloseTo(0.318 * 1.2, 3)
    const motion = data.videos.find((m: any) => m.id === 'hf-genjutsu-motion-transfer')
    expect(motion.price.unit).toBe('second')
    expect(motion.price.usd).toBeCloseTo(0.681 * 1.2, 3)
  })

  test('the listing is cached so a page of models does not hammer /estimate', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0940')
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')
    await listMediaModels()
    const first = fetchLog.filter((f) => f.url.startsWith('https://hf.test/estimate/')).length
    await listMediaModels()
    const second = fetchLog.filter((f) => f.url.startsWith('https://hf.test/estimate/')).length
    expect(second).toBe(first)
  })

  test('fal models stay routable but are marked deprecated with a replacement', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0940')
    mockEstimate('minimax/hailuo-2.3/standard/text-to-video', '0.0700')
    const data = await listMediaModels() as any
    const ids = [...data.images, ...data.videos].map((m: any) => m.id)
    // fal entries are hidden without a FAL_KEY, so check the catalog itself.
    const { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } = await import('@shogo/model-catalog')
    // Each fal model points at the Higgsfield model that does the same job.
    expect((IMAGE_MODEL_CATALOG as any)['nano-banana-pro']).toMatchObject({ deprecated: true, replacement: 'hf-qwen-image-3' })
    expect((IMAGE_MODEL_CATALOG as any)['nano-banana-2']).toMatchObject({ deprecated: true, replacement: 'hf-qwen-image-3' })
    expect((IMAGE_MODEL_CATALOG as any)['seedream-5-pro']).toMatchObject({ deprecated: true, replacement: 'hf-qwen-image-3' })
    expect((IMAGE_MODEL_CATALOG as any)['recraft-3']).toMatchObject({ deprecated: true, replacement: 'hf-recraft-v4.1' })
    expect((IMAGE_MODEL_CATALOG as any)['flux-pro-ultra']).toMatchObject({ deprecated: true, replacement: 'hf-marketing-studio-flare' })
    expect((IMAGE_MODEL_CATALOG as any)['ideogram-3']).toMatchObject({ deprecated: true, replacement: 'hf-ideogram-4' })
    expect((VIDEO_MODEL_CATALOG as any)['kling-2.5-turbo-pro']).toMatchObject({ deprecated: true, replacement: 'hf-hailuo-2.3' })
    expect(ids).not.toContain('kling-2.5-turbo-pro')
  })

  test('lists all 15 Higgsfield image models with a non-null price, best_for and reference limit', async () => {
    // No /estimate routes are mocked: every quote fails, so each price has to
    // come from the catalog instead of blanking the listing.
    const data = await listMediaModels() as any
    const higgsfield = data.images.filter((m: any) => m.provider === 'higgsfield')
    expect(higgsfield.length).toBe(15)
    for (const model of higgsfield) {
      expect(model.price.usd).toBeGreaterThan(0)
      expect(['estimate', 'catalog']).toContain(model.price.source)
      expect(typeof model.best_for).toBe('string')
      expect(model.best_for.length).toBeGreaterThan(0)
      expect(typeof model.max_reference_images).toBe('number')
      expect(model.price.unit).toBe('image')
    }
    // The three token-priced endpoints have no per-request quote: documented
    // catalog figure, never null.
    const flare = higgsfield.find((m: any) => m.id === 'hf-marketing-studio-flare')
    expect(flare.price.source).toBe('catalog')
    expect(flare.price.usd).toBeCloseTo(0.084 * 1.2, 4)
  })

  test('a model whose /estimate throws does not blank or 500 the listing', async () => {
    mockEstimate('higgsfield-ai/soul/v2/standard', '0.0940')
    on('https://hf.test/estimate/z-image/turbo', () => json({ detail: 'boom' }, 500))
    const data = await listMediaModels() as any
    const ids = data.images.map((m: any) => m.id)
    expect(ids).toContain('hf-z-image-turbo')
    expect(ids).toContain('hf-soul-v2')
    // The estimate succeeded for SOUL V2 and failed for Z-Image.
    expect(data.images.find((m: any) => m.id === 'hf-soul-v2').price.source).toBe('estimate')
    expect(data.images.find((m: any) => m.id === 'hf-z-image-turbo').price.source).toBe('catalog')
  })

  test('a catalog entry with no request shape still lists, and never rejects the listing', async () => {
    // The pre-fix failure mode: `buildHiggsfieldImageRequest` threw for any id
    // it did not know, and that throw rejected the whole `list_media_models`.
    const catalog = IMAGE_MODEL_CATALOG as unknown as Record<string, any>
    catalog['hf-qa-unshaped'] = {
      id: 'hf-qa-unshaped', provider: 'higgsfield', apiModel: 'qa/unshaped',
      displayName: 'QA Unshaped', capabilities: { textToImage: true, imageToImage: false, maxReferenceImages: 0 },
      usdPerRequest: 0.02, bestFor: 'the no-shape fallback',
    }
    try {
      const data = await listMediaModels() as any
      const ids = data.images.map((m: any) => m.id)
      expect(ids).toContain('hf-qa-unshaped')
      expect(ids).toContain('hf-ideogram-4')
      expect(data.images.find((m: any) => m.id === 'hf-qa-unshaped').price.usd).toBeCloseTo(0.02 * 1.2, 4)
    } finally {
      delete catalog['hf-qa-unshaped']
    }
  })

  test('publishes low/hd and per-size prices for a non-Higgsfield image model', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    try {
      const data = await listMediaModels() as any
      const gpt = data.images.find((m: any) => m.id === 'gpt-image-2')
      expect(gpt.price.usd).toBeCloseTo(0.053 * 1.2, 4)
      expect(gpt.price.hd_usd).toBeCloseTo(0.211 * 1.2, 4)
      expect(gpt.price.low_usd).toBeCloseTo(0.006 * 1.2, 4)
      expect(gpt.price.usd_by_size['1024x1536']).toBeCloseTo(0.041 * 1.2, 4)
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })

  test('cross-workspace tokens get their own (empty) job view', async () => {
    const res = await call('/ai/v1/videos/vid_missing', {}, OTHER_WS_TOKEN)
    expect(res.status).toBe(404)
  })
})
