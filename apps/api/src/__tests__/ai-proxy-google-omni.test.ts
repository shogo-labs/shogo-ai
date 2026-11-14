// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini Omni 1.2 Flash through the AI proxy: submit, poll, content, the
 * `previous_job_id` chain (upscale / edit / extend), usage-token billing and the
 * `list_media_models` entry.
 *
 * No external network: `globalThis.fetch` is stubbed by URL. Nothing in this
 * file may reach generativelanguage.googleapis.com.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-google-omni.test.ts
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
  resolveBillingWorkspaceId: async (workspaceId: string) => workspaceId,
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
const VIDEO_B64 = 'AAAAIGZ0eXBpc29t'

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
const { aiProxyRoutes, listMediaModels } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { calculateGoogleVideoUsageCost, MARKUP_MULTIPLIER } = await import('../lib/usage-cost')
const { _testing: jobStore } = await import('../lib/video-job-store')

const app = new Hono()
app.route('/api', aiProxyRoutes())
let TOKEN: string
let OTHER_TOKEN: string
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
  OTHER_TOKEN = await generateProxyToken('proj-2', 'ws-2', 'user-2')
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
  jobStore.records.clear()
  jobStore.charged.clear()
})

const submit = async (payload: Record<string, unknown>, token = TOKEN) => {
  const res = await call('/ai/v1/videos/generations', { method: 'POST', body: JSON.stringify(payload) }, token)
  return { res, data: await res.json() as any }
}

/** A queued Omni interaction (the POST answer). */
const queued = (id = 'int_video_1') => ({ id, status: 'in_progress' })

/** A finished Omni interaction with the given usage block. */
const finished = (overrides: Record<string, unknown> = {}) => ({
  id: 'int_video_1',
  status: 'completed',
  steps: [
    { type: 'model_output', content: [{ type: 'video', data: VIDEO_B64, mime_type: 'video/mp4' }] },
  ],
  usage: { output_tokens_by_modality: { video: 5_793 } },
  ...overrides,
})

/** Submit one 360p draft and return its id, with Google mocked end to end. */
async function draft() {
  on(INTERACTIONS, () => json(queued()))
  const { res, data } = await submit({
    model: 'google-omni-1.2-flash',
    prompt: 'A red paper boat drifting across a calm pond.',
    resolution: '360p',
    duration: 3,
  })
  expect(res.status).toBe(200)
  expect(data.id).toStartWith('vid_')
  // The draft's own routes are done with: whatever the test registers next
  // (status, content) must be the only thing the stub answers.
  routes = []
  fetchLog = []
  return data.id as string
}

// =========================================================================
// Cost helper
// =========================================================================

describe('calculateGoogleVideoUsageCost', () => {
  test('prices video output from the usage tokens and marks it up', () => {
    // 3 s at 360p = 5,793 video tokens (1,931 / s) at $12 / M.
    const cost = calculateGoogleVideoUsageCost({ output_tokens_by_modality: { video: 5_793 } })
    expect(cost.rawUsd).toBeCloseTo(0.069516, 6)
    expect(cost.billedUsd).toBeCloseTo(0.069516 * MARKUP_MULTIPLIER, 6)
  })

  test('bills input and text output at their own rates', () => {
    const cost = calculateGoogleVideoUsageCost({
      total_input_tokens: 1_000_000,
      output_tokens_by_modality: { video: 0, text: 1_000_000 },
      total_thought_tokens: 0,
    })
    expect(cost.rawUsd).toBeCloseTo(1.5 + 9, 6)
  })

  test('without a modality split every output token is billed as video', () => {
    const cost = calculateGoogleVideoUsageCost({ total_output_tokens: 5_793 })
    expect(cost.rawUsd).toBeCloseTo(0.069516, 6)
  })
})

// =========================================================================
// Validation (before any spend hold)
// =========================================================================

describe('POST /ai/v1/videos/generations — Omni validation', () => {
  test('401 without a proxy token', async () => {
    const { res, data } = await submit({ prompt: 'x' }, null as any)
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('invalid_api_key')
    expect(fetchLog).toHaveLength(0)
  })

  test('503 provider_not_configured without a Google key', async () => {
    delete process.env.GOOGLE_API_KEY
    const { res, data } = await submit({ model: 'google-omni-1.2-flash', prompt: 'x', duration: 3 })
    expect(res.status).toBe(503)
    expect(data.error.code).toBe('provider_not_configured')
    expect(fetchLog).toHaveLength(0)
  })

  test('more than 6 images is refused before submit', async () => {
    const { res, data } = await submit({
      model: 'google-omni-1.2-flash',
      prompt: 'x',
      duration: 3,
      // Six references is the documented cap; a start image on top of them is a
      // seventh image, which Google will not take.
      start_image: 'data:image/png;base64,AAAA',
      reference_images: Array.from({ length: 6 }, () => 'data:image/png;base64,AAAA'),
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('too_many_images')
    expect(fetchLog).toHaveLength(0)
  })

  test('an unsupported aspect ratio is refused', async () => {
    const { res, data } = await submit({
      model: 'google-omni-1.2-flash', prompt: 'x', duration: 3, aspect_ratio: '1:1',
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_aspect_ratio')
    expect(fetchLog).toHaveLength(0)
  })

  test('a duration outside 3–15 s is refused', async () => {
    const { res, data } = await submit({ model: 'google-omni-1.2-flash', prompt: 'x', duration: 16 })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_duration')
    expect(fetchLog).toHaveLength(0)
  })

  test('two frames (start_image + reference) over 10 s is refused', async () => {
    const { res, data } = await submit({
      model: 'google-omni-1.2-flash',
      prompt: 'x',
      duration: 12,
      start_image: 'data:image/png;base64,AAAA',
      reference_images: ['data:image/png;base64,BBBB'],
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_duration')
    expect(data.error.message).toContain('10 s')
    expect(fetchLog).toHaveLength(0)
  })
})

// =========================================================================
// Generation
// =========================================================================

describe('POST /ai/v1/videos/generations — Omni generation', () => {
  test('submits a background interaction at 360p and returns the job', async () => {
    let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      expect((init?.headers as any)['x-goog-api-key']).toBe('google-test-key')
      return json(queued())
    })

    const { res, data } = await submit({
      model: 'google-omni-1.2-flash',
      prompt: 'A red paper boat drifting across a calm pond.',
      resolution: '360p',
      duration: 3,
      aspect_ratio: '16:9',
    })

    expect(res.status).toBe(200)
    expect(wire).toMatchObject({
      model: 'gemini-omni-1.2-flash',
      input: 'A red paper boat drifting across a calm pond.',
      response_format: { type: 'video', aspect_ratio: '16:9', resolution: '360p', duration: '3s' },
      background: true,
      store: true,
    })
    expect(wire.previous_interaction_id).toBeUndefined()
    expect(data).toMatchObject({
      model: 'google-omni-1.2-flash',
      provider: 'google',
      duration: 3,
      status: 'queued',
      price_source: 'rate_card',
    })
    // 3 s at 360p on the rate card, marked up.
    expect(data.estimated_usd).toBeCloseTo(0.069 * MARKUP_MULTIPLIER, 3)
  })

  test('a model option cannot redirect the model or resolution we bill', async () => {
    let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      return json(queued())
    })
    await submit({
      model: 'google-omni-1.2-flash',
      prompt: 'x',
      resolution: '360p',
      duration: 3,
      options: { model: 'veo-9', response_format: { type: 'image' } },
    })
    expect(wire.model).toBe('gemini-omni-1.2-flash')
    expect(wire.response_format).toMatchObject({ type: 'video', resolution: '360p' })
  })

  test('image-to-video inlines the start image as a block', async () => {
    let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      return json(queued())
    })
    await submit({
      model: 'google-omni-1.2-flash',
      prompt: 'the boat starts moving',
      start_image: 'data:image/png;base64,AAAA',
      duration: 3,
      resolution: '360p',
    })
    expect(Array.isArray(wire.input)).toBe(true)
    expect(wire.input[0]).toEqual({ type: 'text', text: 'the boat starts moving' })
    expect(wire.input[1]).toEqual({ type: 'image', data: 'AAAA', mime_type: 'image/png' })
    expect(wire.generation_config).toBeUndefined()
  })
})

// =========================================================================
// Status, billing, content
// =========================================================================

describe('GET /ai/v1/videos/:id — Omni status', () => {
  test('a completed job bills from its usage tokens exactly once', async () => {
    const id = await draft()
    on(`${INTERACTIONS}/${'int_video_1'}`, () => json(finished()))

    const first = await call(`/ai/v1/videos/${id}`)
    const firstBody = await first.json() as any
    expect(first.status).toBe(200)
    expect(firstBody).toMatchObject({
      status: 'completed',
      video: { url: null, content_path: `/v1/videos/${id}/content`, content_type: 'video/mp4' },
    })

    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({
      workspaceId: 'ws-1',
      actionType: 'ai_video_generation',
      rawUsd: 0.069516,
      billedUsd: 0.069516 * MARKUP_MULTIPLIER,
    })
    expect(consumeCalls[0].actionMetadata).toMatchObject({
      model: 'google-omni-1.2-flash',
      provider: 'google',
      priceSource: 'usage',
      resolution: '360p',
    })

    // Polled again on the same job: the claim is taken, so nothing is charged twice.
    const second = await call(`/ai/v1/videos/${id}`)
    expect((await second.json() as any).status).toBe('completed')
    await settle()
    expect(consumeCalls).toHaveLength(1)
  })

  test('a failed job is never charged and keeps its reason', async () => {
    const id = await draft()
    on(`${INTERACTIONS}/int_video_1`, () =>
      json({ id: 'int_video_1', status: 'failed', error: { message: 'blocked by safety filters' } }))

    const res = await call(`/ai/v1/videos/${id}`)
    const data = await res.json() as any
    expect(data.status).toBe('failed')
    expect(data.error).toContain('safety')
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('another workspace cannot read the job', async () => {
    const id = await draft()
    const res = await call(`/ai/v1/videos/${id}`, {}, OTHER_TOKEN)
    expect(res.status).toBe(404)
  })
})

describe('GET /ai/v1/videos/:id/content — Omni clip bytes', () => {
  test('streams the decoded MP4 to the owning workspace', async () => {
    const id = await draft()
    on(`${INTERACTIONS}/int_video_1`, () => json(finished()))

    const res = await call(`/ai/v1/videos/${id}/content`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(VIDEO_B64, 'base64'))
  })

  test('another workspace gets 404 and Google is never asked', async () => {
    const id = await draft()
    fetchLog = []
    const res = await call(`/ai/v1/videos/${id}/content`, {}, OTHER_TOKEN)
    expect(res.status).toBe(404)
    expect(fetchLog).toHaveLength(0)
  })

  test('an unfinished job answers video_not_ready', async () => {
    const id = await draft()
    on(`${INTERACTIONS}/int_video_1`, () => json({ id: 'int_video_1', status: 'in_progress' }))
    const res = await call(`/ai/v1/videos/${id}/content`)
    expect(res.status).toBe(404)
    expect((await res.json() as any).error.code).toBe('video_not_ready')
  })
})

// =========================================================================
// previous_job_id — upscale / edit / extend
// =========================================================================

describe('POST /ai/v1/videos/generations — previous_job_id', () => {
  test('an upscale continues the parent interaction at the higher resolution', async () => {
    const draftId = await draft()
        let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      return json(queued('int_upscaled'))
    })

    const { res, data } = await submit({
      model: 'google-omni-1.2-flash',
      previous_job_id: draftId,
      resolution: '1080p',
    })
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ duration: 3, provider: 'google', previous_job_id: draftId })
    expect(wire).toMatchObject({
      previous_interaction_id: 'int_video_1',
      input: expect.stringContaining('Re-render this exact video'),
      response_format: { type: 'video', resolution: '1080p', duration: '3s', aspect_ratio: '16:9' },
    })
    // An upscale keeps the parent's length and asks for no task.
    expect(wire.generation_config).toBeUndefined()
  })

  test('a resolution at or below the parent is refused', async () => {
    const draftId = await draft()
    routes = []
    const { res, data } = await submit({
      model: 'google-omni-1.2-flash', previous_job_id: draftId, resolution: '360p',
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_resolution')
    expect(fetchLog).toHaveLength(0)
  })

  test('a prompt turns the follow-up into an edit', async () => {
    const draftId = await draft()
        let wire: any
    on(INTERACTIONS, (_url, init) => {
      wire = JSON.parse(String(init?.body))
      return json(queued('int_edited'))
    })
    const { res } = await submit({
      model: 'google-omni-1.2-flash',
      previous_job_id: draftId,
      prompt: 'swap the paper boat for a wooden one',
      resolution: '1080p',
      duration: 3,
    })
    expect(res.status).toBe(200)
    expect(wire.previous_interaction_id).toBe('int_video_1')
    expect(wire.generation_config).toEqual({ video_config: { task: 'edit' } })
    expect(wire.input).toBe('swap the paper boat for a wooden one')
  })

  test('extending past 30 s total is refused', async () => {
    const draftId = await draft()
    routes = []
    // The draft is 3 s; ask for 15 s more twice over by faking a long parent.
    const job = jobStore.records.get(`video-job:${draftId}`)!.record
    job.duration = 25
    const { res, data } = await submit({
      model: 'google-omni-1.2-flash',
      previous_job_id: draftId,
      prompt: 'keep going',
      options: { task: 'extend' },
      duration: 10,
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('extension_too_long')
    expect(fetchLog).toHaveLength(0)
  })

  test("another workspace's job id is a 404, never a cross-tenant continue", async () => {
    const draftId = await draft()
    routes = []
    const { res, data } = await submit(
      { model: 'google-omni-1.2-flash', previous_job_id: draftId, resolution: '1080p' },
      OTHER_TOKEN,
    )
    expect(res.status).toBe(404)
    expect(data.error.code).toBe('job_not_found')
    expect(fetchLog).toHaveLength(0)
  })

  test('a Higgsfield job id cannot be continued as an Omni clip', async () => {
    jobStore.records.set('video-job:vid_hf', {
      record: {
        id: 'vid_hf', provider: 'higgsfield', workspaceId: 'ws-1', projectId: 'proj-1',
        model: 'hf-kling-3.0-std', endpoint: 'x', statusUrl: 'https://hf.test/x',
        duration: 5, audio: false, imageToVideo: false, createdAt: Date.now(),
      },
      expiresAt: Date.now() + 60_000,
    })
    routes = []
    const { res, data } = await submit({
      model: 'google-omni-1.2-flash', previous_job_id: 'vid_hf', prompt: 'edit it',
    })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('previous_job_unsupported')
    expect(fetchLog).toHaveLength(0)
  })
})

// =========================================================================
// list_media_models
// =========================================================================

describe('list_media_models — Gemini Omni', () => {
  test('lists the model with all four resolutions and their marked-up rates', async () => {
    const data = await listMediaModels(undefined, { kind: 'video' }) as any
    const omni = data.videos.find((entry: any) => entry.id === 'google-omni-1.2-flash')
    expect(omni).toBeDefined()
    expect(omni.text_to_video).toBe(true)
    expect(omni.image_to_video).toBe(true)
    expect(omni.max_reference_images).toBe(6)
    expect(omni.audio).toBe(true)
    expect(omni.parameters.resolutions).toEqual(['360p', '720p', '1080p', '4k'])
    expect(omni.parameters.durations).toContain(15)
    expect(omni.parameters.aspect_ratios).toEqual(['16:9', '9:16'])
    expect(omni.options.map((option: any) => option.name)).toContain('task')
    expect(omni.price.unit).toBe('second')
    expect(omni.price.source).toBe('rate_card')
    expect(omni.price.by_resolution['360p']).toBeCloseTo(0.023 * MARKUP_MULTIPLIER, 4)
    expect(omni.price.by_resolution['4k']).toBeCloseTo(0.209 * MARKUP_MULTIPLIER, 4)
    expect(omni.price.default_clip_usd).toBeCloseTo(0.7 * MARKUP_MULTIPLIER, 4)
    expect(omni.available).toBeUndefined()
  })

  test('is listed but unavailable when the server has no Google key', async () => {
    delete process.env.GOOGLE_API_KEY
    const data = await listMediaModels(undefined, { kind: 'video' }) as any
    const omni = data.videos.find((entry: any) => entry.id === 'google-omni-1.2-flash')
    expect(omni.available).toBe(false)
    expect(omni.requires).toBe('provider_not_configured')
  })

  test('a free plan marks it paid_plan first', async () => {
    const data = await listMediaModels(undefined, { kind: 'video', paidPlan: false }) as any
    const omni = data.videos.find((entry: any) => entry.id === 'google-omni-1.2-flash')
    expect(omni.available).toBe(false)
    expect(omni.requires).toBe('paid_plan')
  })
})
