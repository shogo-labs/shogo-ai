// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * fal.ai media: image generation and edits through fal, the image process
 * route, the media model listing, and the video submit/status routes
 * (including charging exactly once per job).
 *
 * No external network: `globalThis.fetch` is stubbed by URL.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-fal-media.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.FAL_KEY = 'fal-test-key'
process.env.OPENAI_API_KEY = 'sk-openai-test'

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
const { aiProxyRoutes, listMediaModels } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { buildFalImageRequests, buildFalVideoRequest, generateImageFal } = await import('../lib/fal-media')
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

// =========================================================================
// Request building
// =========================================================================

describe('buildFalImageRequests', () => {
  test('nano-banana maps n, aspect ratio and hd resolution', () => {
    const [req] = buildFalImageRequests(IMAGE_MODEL_CATALOG['nano-banana-pro'] as any, {
      prompt: 'a cat', size: '1792x1024', quality: 'hd', n: 3,
    })
    expect(req.endpoint).toBe('fal-ai/nano-banana-pro')
    expect(req.input).toMatchObject({ prompt: 'a cat', num_images: 3, aspect_ratio: '16:9', resolution: '2K' })
  })

  test('references switch nano-banana to its edit endpoint with image_urls', () => {
    const refs = ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']
    const [req] = buildFalImageRequests(IMAGE_MODEL_CATALOG['nano-banana-2'] as any, { prompt: 'x', referenceImages: refs })
    expect(req.endpoint).toBe('fal-ai/nano-banana-2/edit')
    expect(req.input.image_urls).toEqual(refs)
  })

  test('recraft fans out one request per image', () => {
    const reqs = buildFalImageRequests(IMAGE_MODEL_CATALOG['recraft-3'] as any, { prompt: 'logo', n: 3 })
    expect(reqs).toHaveLength(3)
  })
})

describe('buildFalVideoRequest', () => {
  test('kling 3 image-to-video uses start_image_url and elements for references', () => {
    const req = buildFalVideoRequest(VIDEO_MODEL_CATALOG['kling-3-pro'] as any, {
      prompt: 'walks', duration: 5, audio: true, startImage: 'data:image/png;base64,S', referenceImages: ['data:image/png;base64,R1', 'data:image/png;base64,R2'],
    })
    expect(req.endpoint).toBe('fal-ai/kling-video/v3/pro/image-to-video')
    expect(req.input).toMatchObject({ duration: '5', generate_audio: true, start_image_url: 'data:image/png;base64,S' })
    expect((req.input.elements as any)[0].frontal_image_url).toBe('data:image/png;base64,R1')
  })

  test('veo uses "Ns" durations', () => {
    const req = buildFalVideoRequest(VIDEO_MODEL_CATALOG['veo-3.1-fast'] as any, { prompt: 'x', duration: 8, aspectRatio: '9:16' })
    expect(req.endpoint).toBe('fal-ai/veo3.1/fast')
    expect(req.input).toMatchObject({ duration: '8s', aspect_ratio: '9:16' })
  })
})

describe('generateImageFal', () => {
  test('downloads every output URL to base64 and keeps the content type', async () => {
    let body: any
    on('https://fal.run/fal-ai/nano-banana-pro', (_url, init) => {
      body = JSON.parse(String(init?.body))
      expect((init?.headers as any).Authorization).toBe('Key k')
      return json({ images: [{ url: 'https://cdn.fal/a.png', content_type: 'image/png' }, { url: 'https://cdn.fal/b.jpg', content_type: 'image/jpeg' }] })
    })
    on('https://cdn.fal/', () => png())
    const result = await generateImageFal('k', IMAGE_MODEL_CATALOG['nano-banana-pro'] as any, { prompt: 'p', n: 2 })
    expect(body.num_images).toBe(2)
    expect(result.data).toHaveLength(2)
    expect(result.data[0].b64_json).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'))
    expect(result.data[1].content_type).toBe('image/jpeg')
  })
})

// =========================================================================
// Image routes
// =========================================================================

describe('POST /ai/v1/images/generations (fal)', () => {
  test('routes a fal model and bills it at its own price', async () => {
    on('https://fal.run/fal-ai/flux-pro/v1.1-ultra', () => json({ images: [{ url: 'https://cdn.fal/x.png' }] }))
    on('https://cdn.fal/', () => png())
    const res = await call('/ai/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a lighthouse', model: 'flux-pro-ultra' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.data[0].b64_json).toBeTruthy()
    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('ai_image_generation')
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.06, 5)
  })
})

describe('POST /ai/v1/images/edits (references)', () => {
  const file = () => new File([new Uint8Array([1, 2, 3])], 'r.png', { type: 'image/png' })

  test('sends every reference to the fal edit endpoint', async () => {
    let body: any
    on('https://fal.run/fal-ai/nano-banana-pro/edit', (_u, init) => {
      body = JSON.parse(String(init?.body))
      return json({ images: [{ url: 'https://cdn.fal/e.png' }] })
    })
    on('https://cdn.fal/', () => png())
    const fd = new FormData()
    fd.append('prompt', 'same character, waving')
    fd.append('model', 'nano-banana-pro')
    fd.append('image', file())
    fd.append('image', file())
    const res = await call('/ai/v1/images/edits', { method: 'POST', body: fd })
    expect(res.status).toBe(200)
    expect(body.image_urls).toHaveLength(2)
    expect(body.image_urls[0]).toStartWith('data:image/png;base64,')
  })

  test('rejects more references than the model allows', async () => {
    const fd = new FormData()
    fd.append('prompt', 'x')
    fd.append('model', 'flux-pro-ultra')
    fd.append('image', file())
    fd.append('image', file())
    const res = await call('/ai/v1/images/edits', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('too_many_reference_images')
    expect(fetchLog).toHaveLength(0)
  })

  test('rejects references for a text-only model', async () => {
    const fd = new FormData()
    fd.append('prompt', 'x')
    fd.append('model', 'recraft-3')
    fd.append('image', file())
    const res = await call('/ai/v1/images/edits', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('reference_images_unsupported')
  })

  test('forwards several references to OpenAI as image[]', async () => {
    let form: FormData | undefined
    on('https://api.openai.com/v1/images/edits', (_u, init) => {
      form = init?.body as FormData
      return json({ data: [{ b64_json: 'aGk=' }] })
    })
    const fd = new FormData()
    fd.append('prompt', 'x')
    fd.append('model', 'gpt-image-1')
    fd.append('image', file())
    fd.append('image', file())
    const res = await call('/ai/v1/images/edits', { method: 'POST', body: fd })
    expect(res.status).toBe(200)
    expect(form?.getAll('image[]')).toHaveLength(2)
  })
})

describe('POST /ai/v1/images/process', () => {
  test('upscales via fal and bills per output megapixel', async () => {
    on('https://fal.run/fal-ai/clarity-upscaler', () =>
      json({ image: { url: 'https://cdn.fal/u.png', content_type: 'image/png', width: 2000, height: 2000 } }))
    on('https://cdn.fal/', () => png())
    const res = await call('/ai/v1/images/process', {
      method: 'POST',
      body: JSON.stringify({ operation: 'upscale', image: 'data:image/png;base64,AAA', scale: 2 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.data[0]).toMatchObject({ content_type: 'image/png', width: 2000 })
    await settle()
    expect(consumeCalls[0].actionType).toBe('ai_image_processing')
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.12, 5)
  })

  test('rejects an unknown operation', async () => {
    const res = await call('/ai/v1/images/process', {
      method: 'POST',
      body: JSON.stringify({ operation: 'colorize', image: 'data:image/png;base64,AAA' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /ai/v1/media/models', () => {
  test('lists image and video models with capabilities and marked-up prices', async () => {
    const res = await call('/ai/v1/media/models')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    const nano = data.images.find((m: any) => m.id === 'nano-banana-pro')
    expect(nano).toMatchObject({ image_to_image: true, max_reference_images: 14, price: { unit: 'image' } })
    expect(nano.price.usd).toBeCloseTo(0.15 * 1.2, 4)
    expect(data.images.some((m: any) => m.id === 'dall-e-3')).toBe(false)
    const kling = data.videos.find((m: any) => m.id === 'kling-3-pro')
    expect(kling).toMatchObject({ image_to_video: true, audio: true, price: { unit: 'second' } })
    expect(kling.price.with_audio_usd).toBeCloseTo(0.168 * 1.2, 4)
    expect(data.utilities.map((u: any) => u.tool)).toEqual(['upscale_image', 'remove_background'])
  })

  test('omits fal models when no fal key is configured', () => {
    const saved = process.env.FAL_KEY
    delete process.env.FAL_KEY
    try {
      const data = listMediaModels()
      expect(data.images.some((m) => m.provider === 'fal')).toBe(false)
      expect(data.videos).toEqual([])
    } finally {
      process.env.FAL_KEY = saved
    }
  })

  test('401 without auth', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/media/models'))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Video routes
// =========================================================================

describe('video routes', () => {
  const STATUS_URL = 'https://queue.fal.run/fal-ai/kling-video/requests/req-1/status'
  const RESPONSE_URL = 'https://queue.fal.run/fal-ai/kling-video/requests/req-1'

  beforeEach(() => {
    videoStore.records.clear()
    videoStore.charged.clear()
  })

  function mockSubmit() {
    let body: any
    on('https://queue.fal.run/fal-ai/kling-video/v3/pro/text-to-video', (_u, init) => {
      body = JSON.parse(String(init?.body))
      return json({ request_id: 'req-1', status_url: STATUS_URL, response_url: RESPONSE_URL })
    })
    return () => body
  }

  async function submit(extra: Record<string, unknown> = {}) {
    const res = await call('/ai/v1/videos/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a fox runs', model: 'kling-3-pro', duration: 5, ...extra }),
    })
    return { res, data: await res.json() as any }
  }

  test('submits to the fal queue and returns a job id with an estimate', async () => {
    const body = mockSubmit()
    const { res, data } = await submit({ audio: true, aspect_ratio: '9:16' })
    expect(res.status).toBe(200)
    expect(data.id).toStartWith('vid_')
    expect(data.status).toBe('queued')
    expect(data.estimated_usd).toBeCloseTo(5 * 0.168 * 1.2, 4)
    expect(body()).toMatchObject({ prompt: 'a fox runs', duration: '5', generate_audio: true, aspect_ratio: '9:16' })
    expect(consumeCalls).toHaveLength(0)
  })

  test('rejects an unsupported duration', async () => {
    const { res, data } = await submit({ model: 'veo-3.1-fast', duration: 5 })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_duration')
  })

  test('rejects references on a model that takes none', async () => {
    const { res, data } = await submit({ model: 'kling-2.5-turbo-pro', reference_images: ['data:image/png;base64,A'] })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('too_many_reference_images')
  })

  test('reports progress, then completes and charges exactly once across polls', async () => {
    mockSubmit()
    const { data } = await submit()
    let state = 'IN_PROGRESS'
    on(STATUS_URL, () => json({ status: state }))
    on(RESPONSE_URL, () => json({ video: { url: 'https://cdn.fal/v.mp4', content_type: 'video/mp4', file_size: 1234 } }))

    const first = await (await call(`/ai/v1/videos/${data.id}`)).json() as any
    expect(first.status).toBe('in_progress')

    state = 'COMPLETED'
    for (let i = 0; i < 3; i++) {
      const done = await (await call(`/ai/v1/videos/${data.id}`)).json() as any
      expect(done.status).toBe('completed')
      expect(done.video.url).toBe('https://cdn.fal/v.mp4')
    }
    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('ai_video_generation')
    expect(consumeCalls[0].rawUsd).toBeCloseTo(5 * 0.112, 5)
  })

  test('a failed job is reported and not charged', async () => {
    mockSubmit()
    const { data } = await submit()
    on(STATUS_URL, () => json({ status: 'COMPLETED', error: 'content policy' }))
    const res = await (await call(`/ai/v1/videos/${data.id}`)).json() as any
    expect(res).toMatchObject({ status: 'failed', error: 'content policy' })
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test("another workspace cannot read a job", async () => {
    mockSubmit()
    const { data } = await submit()
    const res = await call(`/ai/v1/videos/${data.id}`, {}, OTHER_WS_TOKEN)
    expect(res.status).toBe(404)
  })
})
