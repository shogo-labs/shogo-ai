// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tripo3D 3D API: submit (generation + post-processing + rigging), status with
 * charge-once billing, file upload, model listing, and the pricing table.
 *
 * No external network: `globalThis.fetch` is stubbed by URL. Nothing in this
 * file may reach openapi.tripo3d.ai.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-3d.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.TRIPO_API_KEY = 'tripo-test-key'

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

const TRIPO = 'https://openapi.tripo3d.ai/v3'
const TASK_ID = '11111111-1111-4111-8111-111111111111'
const TASK_URL = `${TRIPO}/tasks/${TASK_ID}`

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
  balanceOk = true
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { _testing: jobStore } = await import('../lib/3d-job-store')
const { estimateTripoTaskCost, calculate3dUsageCost } = await import('../lib/usage-cost')
const { TRIPO_OPS } = await import('../lib/tripo-3d')

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
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as any),
    },
  }))

/** Billing is fire-and-forget; let the microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  jobStore.records.clear()
  jobStore.charged.clear()
})

/** Route the submit call for `op` and capture the wire body. */
function mockSubmit(body: Record<string, unknown>, taskId = TASK_ID) {
  on((url) => url.startsWith(`${TRIPO}/`) && url !== `${TRIPO}/tasks/${taskId}`, (_url, init) => {
    Object.assign(body, JSON.parse(String(init?.body)))
    expect((init?.headers as any).Authorization).toBe('Bearer tripo-test-key')
    return json({ code: 0, data: { task_id: taskId } })
  })
  return body
}

const submit = async (payload: Record<string, unknown>) => {
  const res = await call('/ai/v1/3d/generations', { method: 'POST', body: JSON.stringify(payload) })
  return { res, data: await res.json() as any }
}

const poll = (id: string, token = TOKEN) => call(`/ai/v1/3d/${id}`, {}, token)

const success = (data: Record<string, unknown>, credits = 20) =>
  json({ code: 0, data: { status: 'success', progress: 100, credits_consumed: credits, ...data } })

// =========================================================================
// Submit — generation ops
// =========================================================================

describe('POST /ai/v1/3d/generations — generation', () => {
  test('text-to-model submits with the server key and prices it from the registry', async () => {
    const wire = mockSubmit({})
    const { res, data } = await submit({ prompt: 'a wooden treasure chest, low poly' })

    expect(res.status).toBe(200)
    expect(data.id).toStartWith('gen3d_')
    expect(data).toMatchObject({
      op: 'text_to_model',
      status: 'queued',
      model: 'tripo-v3.1',
      estimated_credits: 20,
      estimated_usd: 0.24,
    })
    // Shogo exposes `tripo-v3.1`; the API only accepts the version string.
    expect(wire).toEqual({ prompt: 'a wooden treasure chest, low poly', model: 'v3.1-20260211' })
    expect(fetchLog.map((f) => f.url)).toEqual([`${TRIPO}/generation/text-to-model`])
    expect(consumeCalls).toHaveLength(0)
  })

  test('forwards the generation options it was given and nothing else', async () => {
    const wire = mockSubmit({})
    const { data } = await submit({ prompt: 'a chair', model: 'tripo-p1', texture: false, face_limit: 8000, quad: true })
    expect(wire).toEqual({ prompt: 'a chair', model: 'P1-20260311', texture: false, face_limit: 8000, quad: true })
    // P-series text-to-model untextured: 30 credits → $0.36
    expect(data.estimated_credits).toBe(30)
    expect(data.estimated_usd).toBe(0.36)
  })

  test('image-to-model uploads a data URI and forwards the file_token', async () => {
    on(`${TRIPO}/files`, (_url, init) => {
      const form = init?.body as FormData
      expect(form).toBeInstanceOf(FormData)
      expect((form.get('file') as File).type).toBe('image/png')
      return json({ code: 0, data: { file_token: 'file_abc123' } })
    })
    const wire = mockSubmit({})
    const { res } = await submit({ image: 'data:image/png;base64,iVBORw0KGgo=' })

    expect(res.status).toBe(200)
    expect(wire).toEqual({ input: 'file_abc123', model: 'v3.1-20260211' })
    expect(fetchLog.map((f) => f.url)).toEqual([`${TRIPO}/files`, `${TRIPO}/generation/image-to-model`])
  })

  test('an https image URL is forwarded untouched', async () => {
    const wire = mockSubmit({})
    const url = 'https://example.com/chair.png'
    const { res } = await submit({ image: url })
    expect(res.status).toBe(200)
    expect(wire).toEqual({ input: url, model: 'v3.1-20260211' })
    expect(fetchLog.some((f) => f.url === `${TRIPO}/files`)).toBe(false)
  })

  test('multiview_to_model uploads all four views in order', async () => {
    let uploads = 0
    on(`${TRIPO}/files`, () => json({ code: 0, data: { file_token: `file_v${uploads++}` } }))
    const wire = mockSubmit({})
    const { res, data } = await submit({
      op: 'multiview_to_model',
      images: [
        'https://example.com/front.png',
        'data:image/png;base64,AAA',
        'https://example.com/back.png',
        'https://example.com/right.png',
      ],
    })

    expect(res.status).toBe(200)
    expect(data.op).toBe('multiview_to_model')
    expect(wire).toMatchObject({
      inputs: ['https://example.com/front.png', 'file_v0', 'https://example.com/back.png', 'https://example.com/right.png'],
      model: 'v3.1-20260211',
    })
    expect(uploads).toBe(1)
  })

  test('multiview with the wrong number of images is rejected before any vendor call', async () => {
    const { res, data } = await submit({ op: 'multiview_to_model', images: ['https://example.com/a.png'] })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_images')
    expect(fetchLog).toHaveLength(0)
  })

  test('prompt and image together is rejected before any vendor call', async () => {
    const { res, data } = await submit({ prompt: 'a chair', image: 'https://example.com/chair.png' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('prompt_and_image')
    expect(fetchLog).toHaveLength(0)
  })

  test('no input at all is rejected', async () => {
    const { res, data } = await submit({ model: 'tripo-v3.1' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('missing_op')
  })

  test('an unsupported model is rejected', async () => {
    const { res, data } = await submit({ prompt: 'x', model: 'tripo-v9' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('model_not_found')
  })

  test('an unknown op is rejected', async () => {
    const { res, data } = await submit({ op: 'make_coffee', prompt: 'x' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('unknown_op')
  })

  test('an op parameter that does not belong to the op is rejected', async () => {
    const { res, data } = await submit({ op: 'convert', input: TASK_ID, format: 'GLB', texture_quality: 'extreme' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('unsupported_field')
    expect(data.error.message).toContain('texture_quality')
  })

  test('an unsupported texture_quality is rejected', async () => {
    const { res, data } = await submit({ prompt: 'x', texture_quality: 'ultra' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_texture_quality')
  })

  test('a vendor error envelope surfaces message and suggestion', async () => {
    on(`${TRIPO}/generation/text-to-model`, () =>
      json({ code: 1004, message: 'invalid prompt', suggestion: 'shorten it' }, 400))
    const { res, data } = await submit({ prompt: 'x' })
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('invalid prompt')
    expect(data.error.message).toContain('shorten it')
  })

  test('no Tripo key answers 503 provider_not_configured', async () => {
    const saved = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    try {
      const { res, data } = await submit({ prompt: 'x' })
      expect(res.status).toBe(503)
      expect(data.error.code).toBe('provider_not_configured')
      expect(fetchLog).toHaveLength(0)
    } finally {
      process.env.TRIPO_API_KEY = saved
    }
  })

  test('exhausted balance answers 402 with the standard usage-limit body and calls nothing', async () => {
    balanceOk = false
    const { res, data } = await submit({ prompt: 'x' })
    expect(res.status).toBe(402)
    expect(data.error).toMatchObject({ type: 'billing_error', code: 'usage_limit_reached' })
    expect(fetchLog).toHaveLength(0)
  })

  test('bad token answers 401 like the media routes', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/generations', { method: 'POST' }))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Submit — post-processing and rigging
// =========================================================================

describe('POST /ai/v1/3d/generations — edit ops', () => {
  test('texture submits against a task id with the right path', async () => {
    const wire = mockSubmit({})
    const { res, data } = await submit({
      op: 'texture',
      input: TASK_ID,
      texture_prompt: { text: 'worn leather' },
      texture_quality: 'detailed',
    })
    expect(res.status).toBe(200)
    expect(data).toMatchObject({ op: 'texture', estimated_credits: 20, estimated_usd: 0.24 })
    expect(fetchLog[0].url).toBe(`${TRIPO}/models/texture`)
    expect(wire).toEqual({ input: TASK_ID, texture_prompt: { text: 'worn leather' }, texture_quality: 'detailed' })
  })

  test('a data URI model input is uploaded and replaced by its token', async () => {
    on(`${TRIPO}/files`, () => json({ code: 0, data: { file_token: 'file_model1' } }))
    const wire = mockSubmit({})
    const { res } = await submit({ op: 'convert', input: 'data:model/gltf-binary;base64,Z2xURg==', format: 'FBX' })
    expect(res.status).toBe(200)
    expect(wire).toEqual({ input: 'file_model1', format: 'FBX' })
  })

  test('convert requires a supported format', async () => {
    const missing = await submit({ op: 'convert', input: TASK_ID })
    expect(missing.res.status).toBe(400)
    expect(missing.data.error.code).toBe('missing_format')

    const bad = await submit({ op: 'convert', input: TASK_ID, format: 'STEP' })
    expect(bad.res.status).toBe(400)
    expect(bad.data.error.code).toBe('unsupported_format')
    expect(fetchLog).toHaveLength(0)
  })

  test('convert upper-cases the format', async () => {
    const wire = mockSubmit({})
    await submit({ op: 'convert', input: TASK_ID, format: 'fbx' })
    expect(wire.format).toBe('FBX')
  })

  test('retopology prices by algorithm version and quad', async () => {
    mockSubmit({})
    const v3 = await submit({ op: 'retopology', input: TASK_ID, model: 'v3.0', quad: true })
    expect(v3.data.estimated_credits).toBe(40)
    const v1 = await submit({ op: 'retopology', input: TASK_ID, model: 'v1.0' })
    expect(v1.data.estimated_credits).toBe(10)
    expect(fetchLog[0].url).toBe(`${TRIPO}/mesh/decimate`)
  })

  test('rig_check is free and still submits', async () => {
    mockSubmit({})
    const { res, data } = await submit({ op: 'rig_check', input: TASK_ID })
    expect(res.status).toBe(200)
    expect(data.estimated_credits).toBe(0)
    expect(data.estimated_usd).toBe(0)
    expect(fetchLog[0].url).toBe(`${TRIPO}/animations/rig-check`)
  })

  test('rig forwards rig_type and prices at 25 credits', async () => {
    const wire = mockSubmit({})
    const { data } = await submit({ op: 'rig', input: TASK_ID, rig_type: 'quadruped', out_format: 'fbx' })
    expect(data.estimated_credits).toBe(25)
    // The animations endpoints reject a missing `model`: the route pins the
    // current rig version so Tripo does not fall back to a retired one.
    expect(wire).toEqual({ input: TASK_ID, rig_type: 'quadruped', out_format: 'fbx', model: 'v2.5-20260210' })
  })

  test('retarget prices per animation and rejects more than five', async () => {
    const wire = mockSubmit({})
    const two = await submit({ op: 'retarget', input: TASK_ID, animations: ['preset:walk', 'preset:run'] })
    expect(two.data.estimated_credits).toBe(20)
    expect(wire.animations).toEqual(['preset:walk', 'preset:run'])

    const six = await submit({
      op: 'retarget',
      input: TASK_ID,
      animations: ['a', 'b', 'c', 'd', 'e', 'f'],
    })
    expect(six.res.status).toBe(400)
    expect(six.data.error.code).toBe('too_many_animations')

    const both = await submit({ op: 'retarget', input: TASK_ID, animation: 'preset:walk', animations: ['preset:run'] })
    expect(both.res.status).toBe(400)
    expect(both.data.error.code).toBe('invalid_animation')
  })

  test('every registered op has a path under /v3 and a positive or zero price', () => {
    for (const [op, spec] of Object.entries(TRIPO_OPS)) {
      expect(spec.path).toStartWith('/')
      expect(spec.estimateCredits({})).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(spec.fields)).toBe(true)
      expect(['model', 'parts']).toContain(spec.produces)
      expect(op).toBeTypeOf('string')
    }
  })
})

// =========================================================================
// Status + billing
// =========================================================================

describe('GET /ai/v1/3d/:id', () => {
  async function queue(payload: Record<string, unknown> = { prompt: 'a lighthouse', model: 'tripo-p1' }) {
    mockSubmit({})
    const { data } = await submit(payload)
    return data.id as string
  }

  test('running reports progress and charges nothing', async () => {
    const id = await queue()
    on(TASK_URL, () => json({ code: 0, data: { status: 'running', progress: 42 } }))

    const res = await poll(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, op: 'text_to_model', status: 'running', progress: 42 })
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('success returns the model_url and charges credits/100 × markup once', async () => {
    const id = await queue()
    on(TASK_URL, () => success({ output: { model_url: 'https://tripo-cdn.example/m.glb' } }, 40))

    const data = await (await poll(id)).json() as any
    expect(data).toMatchObject({
      id,
      status: 'success',
      model_url: 'https://tripo-cdn.example/m.glb',
      credits_consumed: 40,
      billed_usd: 0.48,
    })

    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('ai_3d_generation')
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.4, 6)
    expect(consumeCalls[0].billedUsd).toBeCloseTo(0.4 * 1.2, 6)
    expect(consumeCalls[0].actionMetadata).toMatchObject({
      model: 'tripo-p1',
      op: 'text_to_model',
      taskId: TASK_ID,
      creditsConsumed: 40,
      input: 'text',
    })
  })

  test('polling a finished job three times charges exactly once, across requests', async () => {
    const id = await queue()
    on(TASK_URL, () => success({ output: { model_url: 'https://tripo-cdn.example/m.glb' } }, 20))

    for (let i = 0; i < 3; i++) {
      expect((await (await poll(id)).json() as any).status).toBe('success')
    }
    await settle()
    expect(consumeCalls).toHaveLength(1)
  })

  test('a free task (rig_check) writes no wallet row at all', async () => {
    mockSubmit({})
    const { data: queued } = await submit({ op: 'rig_check', input: TASK_ID })
    on(TASK_URL, () => success({ riggable: true, rig_type: 'biped' }, 0))

    const data = await (await poll(queued.id)).json() as any
    expect(data).toMatchObject({ status: 'success', riggable: true, rig_type: 'biped', credits_consumed: 0, billed_usd: 0 })
    await settle()
    expect(consumeCalls).toHaveLength(0)
    // Not claimed either, so a later poll cannot bill it.
    expect(jobStore.charged.size).toBe(0)
  })

  test('segment returns part names and bills its 40 credits', async () => {
    mockSubmit({})
    const { data: queued } = await submit({ op: 'segment', input: TASK_ID })
    expect(queued.estimated_credits).toBe(40)
    on(TASK_URL, () => success({ output: { part_names: ['head', 'torso', 'arm_l'] } }, 40))

    const data = await (await poll(queued.id)).json() as any
    expect(data.status).toBe('success')
    expect(data.parts).toEqual(['head', 'torso', 'arm_l'])
    await settle()
    expect(consumeCalls).toHaveLength(1)
  })

  test('retarget returns every animated model url', async () => {
    mockSubmit({})
    const { data: queued } = await submit({ op: 'retarget', input: TASK_ID, animations: ['preset:walk', 'preset:run'] })
    on(TASK_URL, () => success({
      output: { model_urls: ['https://tripo-cdn.example/walk.glb', 'https://tripo-cdn.example/run.glb'] },
    }, 20))

    const data = await (await poll(queued.id)).json() as any
    expect(data.model_urls).toHaveLength(2)
    expect(data.billed_usd).toBe(0.24)
  })

  test('a failed task surfaces the error and is not charged', async () => {
    const id = await queue()
    on(TASK_URL, () => json({
      code: 0,
      data: { status: 'failed', progress: 0, error_code: 2000, error_message: 'content policy' },
    }))

    const res = await poll(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, status: 'failed', error: 'content policy' })
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('a cancelled task reports failed and is not charged', async () => {
    const id = await queue()
    on(TASK_URL, () => json({ code: 0, data: { status: 'cancelled' } }))
    expect((await (await poll(id)).json() as any).status).toBe('failed')
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('success without any output is reported as failed, not billed', async () => {
    const id = await queue()
    on(TASK_URL, () => success({}, 20))
    const data = await (await poll(id)).json() as any
    expect(data.status).toBe('failed')
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('an unknown job is a 404', async () => {
    const res = await poll('gen3d_does-not-exist')
    expect(res.status).toBe(404)
    expect((await res.json() as any).error.code).toBe('job_not_found')
  })

  test('another workspace cannot read a job', async () => {
    const id = await queue()
    const res = await poll(id, OTHER_WS_TOKEN)
    expect(res.status).toBe(404)
  })

  test('no Tripo key answers 503 on the status route too', async () => {
    const id = await queue()
    const saved = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    try {
      const res = await poll(id)
      expect(res.status).toBe(503)
      expect((await res.json() as any).error.code).toBe('provider_not_configured')
    } finally {
      process.env.TRIPO_API_KEY = saved
    }
  })
})

// =========================================================================
// File upload
// =========================================================================

describe('POST /ai/v1/3d/files', () => {
  const upload = (body: Record<string, unknown>, token = TOKEN) =>
    call('/ai/v1/3d/files', { method: 'POST', body: JSON.stringify(body) }, token)

  test('uploads and returns a file_token', async () => {
    on(`${TRIPO}/files`, (_url, init) => {
      const form = init?.body as FormData
      expect((form.get('file') as File).name).toBe('chair.png')
      return json({ code: 0, data: { file_token: 'file_abc123' } })
    })
    const res = await upload({ filename: 'chair.png', contentType: 'image/png', data_base64: 'iVBORw0KGgo=' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ file_token: 'file_abc123', bytes: 8, content_type: 'image/png' })
  })

  test('a file over the limit is a 413 naming the cap', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024).toString('base64')
    const res = await upload({ filename: 'big.glb', contentType: 'model/gltf-binary', data_base64: huge })
    expect(res.status).toBe(413)
    expect((await res.json() as any).error.code).toBe('file_too_large')
    expect(fetchLog).toHaveLength(0)
  })

  test('missing data_base64 is a 400', async () => {
    const res = await upload({ filename: 'chair.png' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('missing_file')
  })

  test('bad token answers 401', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/files', { method: 'POST' }))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Model listing
// =========================================================================

describe('GET /ai/v1/3d/models', () => {
  test('lists runnable models, prices and every operation', async () => {
    const res = await call('/ai/v1/3d/models')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.currency).toBe('USD')
    expect(data.note).toContain('markup')

    const v31 = data.models.find((m: any) => m.id === 'tripo-v3.1')
    expect(v31).toMatchObject({ text_to_model: true, image_to_model: true, multiview_to_model: true })
    expect(v31.price.usd).toBeCloseTo(0.24, 4)
    expect(v31.price.untextured_usd).toBeCloseTo(0.12, 4)
    expect(data.models.find((m: any) => m.id === 'tripo-p1').price.usd).toBeCloseTo(0.48, 4)

    expect(data.operations.map((o: any) => o.op).sort()).toEqual(Object.keys(TRIPO_OPS).sort())
    expect(data.operations.find((o: any) => o.op === 'rig_check').estimated_credits).toBe(0)
    expect(data.operations.find((o: any) => o.op === 'retarget').estimated_credits).toBe(10)
  })

  test('lists nothing when the key is absent', async () => {
    const saved = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    try {
      const data = await (await call('/ai/v1/3d/models')).json() as any
      expect(data.models).toEqual([])
      expect(data.operations).toEqual([])
    } finally {
      process.env.TRIPO_API_KEY = saved
    }
  })

  test('bad token answers 401', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/models'))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Pricing
// =========================================================================

describe('estimateTripoTaskCost', () => {
  const credits = (p: Parameters<typeof estimateTripoTaskCost>[0]) =>
    Math.round(estimateTripoTaskCost(p).rawUsd * 100)

  test('H-series generation: text 10 / 20, image 20 / 30, multiview 20 / 30', () => {
    expect(credits({ op: 'text_to_model', model: 'tripo-v3.1', texture: false })).toBe(10)
    expect(credits({ op: 'text_to_model', model: 'tripo-v3.1' })).toBe(20)
    expect(credits({ op: 'image_to_model', model: 'tripo-v3.1', texture: false })).toBe(20)
    expect(credits({ op: 'image_to_model', model: 'tripo-v3.1' })).toBe(30)
    expect(credits({ op: 'multiview_to_model', model: 'tripo-v3.1', texture: false })).toBe(20)
    expect(credits({ op: 'multiview_to_model', model: 'tripo-v3.1' })).toBe(30)
  })

  test('P-series adds 20 credits to every generation cell', () => {
    expect(credits({ op: 'text_to_model', model: 'tripo-p1', texture: false })).toBe(30)
    expect(credits({ op: 'text_to_model', model: 'tripo-p1' })).toBe(40)
    expect(credits({ op: 'image_to_model', model: 'tripo-p1', texture: false })).toBe(40)
    expect(credits({ op: 'image_to_model', model: 'tripo-p1' })).toBe(50)
    expect(credits({ op: 'multiview_to_model', model: 'tripo-p1' })).toBe(50)
  })

  test('texture_quality tiers: standard / detailed / extreme', () => {
    expect(credits({ op: 'text_to_model', model: 'tripo-v3.1', textureQuality: 'standard' })).toBe(20)
    expect(credits({ op: 'text_to_model', model: 'tripo-v3.1', textureQuality: 'detailed' })).toBe(30)
    expect(credits({ op: 'text_to_model', model: 'tripo-v3.1', textureQuality: 'extreme' })).toBe(40)
    expect(credits({ op: 'image_to_model', model: 'tripo-p1', textureQuality: 'extreme' })).toBe(70)
  })

  test('pbr counts as textured, since Tripo forces it upstream', () => {
    expect(credits({ op: 'text_to_model', model: 'tripo-v3.1', texture: false, pbr: true })).toBe(20)
  })

  test('fixed-price ops match the published table', () => {
    expect(credits({ op: 'texture' })).toBe(10)
    expect(credits({ op: 'texture', textureQuality: 'detailed' })).toBe(20)
    expect(credits({ op: 'texture', textureQuality: 'extreme' })).toBe(30)
    // Measured live 2026-10-18: an FBX convert charged 10, not the 5 the
    // published table implies. Billing uses the reported number; this is the
    // pre-flight estimate, which errs high on purpose.
    expect(credits({ op: 'convert' })).toBe(10)
    expect(credits({ op: 'retopology', model: 'v2.0' })).toBe(30)
    expect(credits({ op: 'retopology', model: 'v3.0' })).toBe(35)
    expect(credits({ op: 'retopology', model: 'v3.0', quad: true })).toBe(40)
    expect(credits({ op: 'segment' })).toBe(40)
    expect(credits({ op: 'complete' })).toBe(50)
    expect(credits({ op: 'rig_check' })).toBe(0)
    expect(credits({ op: 'rig' })).toBe(25)
    expect(credits({ op: 'retarget', animation: 'preset:walk' })).toBe(10)
    expect(credits({ op: 'retarget', animations: ['a', 'b', 'c'] })).toBe(30)
    expect(credits({ op: 'import' })).toBe(0)
  })

  test('markup is 1.2 on every estimate', () => {
    const cost = estimateTripoTaskCost({ op: 'text_to_model', model: 'tripo-v3.1' })
    expect(cost.billedUsd).toBeCloseTo(cost.rawUsd * 1.2, 6)
  })

  test('calculate3dUsageCost bills credits at $0.01 with the markup', () => {
    expect(calculate3dUsageCost(20)).toEqual({ rawUsd: 0.2, billedUsd: 0.2 * 1.2 })
    expect(calculate3dUsageCost(0)).toEqual({ rawUsd: 0, billedUsd: 0 })
  })
})

// =========================================================================
// Callers' wire contract
//
// The two callers live in other packages (`packages/agent-runtime/src/
// three-d-tools.ts` and `packages/sdk/bin/three-d-cli.mjs`) and their own
// tests stub the proxy, so a field-name drift between them and this route
// stays invisible. Each body below is copied from the caller at the line
// named in the test, and must be accepted by the real route.
// =========================================================================

describe('callers wire contract', () => {
  test('three-d-tools upload body (data_base64) is accepted', async () => {
    // three-d-tools.ts `uploadFile()`: { filename, contentType, data_base64 }
    on(`${TRIPO}/files`, () => json({ code: 0, data: { file_token: 'file_from_tool' } }))
    const res = await call('/ai/v1/3d/files', {
      method: 'POST',
      body: JSON.stringify({ filename: 'chest.glb', contentType: 'model/gltf-binary', data_base64: 'Z2xURg==' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as any).file_token).toBe('file_from_tool')
  })

  test('three-d-cli upload body (data_base64) is accepted', async () => {
    // three-d-cli.mjs `upload()`: { filename, contentType, data_base64 }
    on(`${TRIPO}/files`, () => json({ code: 0, data: { file_token: 'file_from_cli' } }))
    const res = await call('/ai/v1/3d/files', {
      method: 'POST',
      body: JSON.stringify({ filename: 'ref.png', contentType: 'image/png', data_base64: 'iVBORw0KGgo=' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as any).file_token).toBe('file_from_cli')
  })

  test('single-animation retarget (animation: string) is accepted', async () => {
    // three-d-tools.ts `edit_3d_model` retarget branch: one preset → `animation`.
    const wire = mockSubmit({})
    const { res } = await submit({ op: 'retarget', input: TASK_ID, animation: 'preset:walk' })
    expect(res.status).toBe(200)
    expect(wire.animation).toBe('preset:walk')
    expect(wire.animations).toBeUndefined()
  })

  test('multi-animation retarget (animations: string[]) is accepted and priced per animation', async () => {
    // three-d-cli.mjs `edit --animations a,b`: a list → `animations`.
    const wire = mockSubmit({})
    const { res, data } = await submit({ op: 'retarget', input: TASK_ID, animations: ['preset:walk', 'preset:run'] })
    expect(res.status).toBe(200)
    expect(wire.animations).toEqual(['preset:walk', 'preset:run'])
    expect(data.estimated_credits).toBe(20)
  })

  test('a generation body never carries format, and the caller does not send one', async () => {
    // three-d-cli.mjs `generate` and three-d-tools.ts `generate_3d_model`:
    // format belongs to convert only, so no generation op allowlists it.
    const wire = mockSubmit({})
    const { res } = await submit({
      op: 'text_to_model',
      prompt: 'a wooden chest',
      model: 'tripo-v3.1',
      texture: true,
    })
    expect(res.status).toBe(200)
    expect('format' in wire).toBe(false)
  })

  test('format on a generation op is still a 400 unsupported_field', async () => {
    const { res, data } = await submit({ op: 'text_to_model', prompt: 'a wooden chest', format: 'GLB' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('unsupported_field')
    expect(fetchLog).toHaveLength(0)
  })

  test('the CLI convert body (op + format, input as task id) is accepted', async () => {
    // three-d-cli.mjs `edit --op convert --input <task> --format USDZ`.
    const wire = mockSubmit({})
    const { res } = await submit({ op: 'convert', input: TASK_ID, format: 'USDZ' })
    expect(res.status).toBe(200)
    expect(wire.format).toBe('USDZ')
    expect(wire.input).toBe(TASK_ID)
  })
})
