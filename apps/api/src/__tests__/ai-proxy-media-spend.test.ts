// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-310 — media billing pre-flight.
 *
 * Two rules, both enforced *before* a provider is called:
 *
 *   1. Video (Genjutsu included) needs a paid plan. Free workspaces get images;
 *      promo credit does not unlock video.
 *   2. Every media job (image, edit, video, music, 3D) is authorized against
 *      its own known price plus what the open turn has already accumulated plus
 *      the holds of jobs still running — in and out of a chat turn.
 *
 * Before this, the media routes probed `checkUsageBalance(ws)` with the default
 * `$0.001`, and skipped that probe entirely while a turn was in flight; the
 * real charge only happened after the media had been delivered, so SigNoz saw
 * 148 `Could not charge video usage` + 227 image equivalents in prod since
 * Oct 20.
 *
 * No network: `globalThis.fetch` is stubbed by URL.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-media-spend.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.HIGGSFIELD_API_KEY = 'hf-test-key'
process.env.HIGGSFIELD_BASE_URL = 'https://hf.test'
process.env.GOOGLE_API_KEY = 'google-test-key'
process.env.GOOGLE_BASE_URL = 'https://google.test'
process.env.OPENAI_API_KEY = 'openai-test-key'
process.env.TRIPO_API_KEY = 'tripo-test-key'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', name: 'Test' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
    workspace: { findUnique: async () => null },
    subscription: { findFirst: async () => null },
  },
}))

// ─── billing controls the tests drive ─────────────────────────────────────
/** How much the workspace can still pay (window room + promo, resolved by the real check). */
let availableUsd = Number.POSITIVE_INFINITY
/** Reason reported when `availableUsd` is too small. */
let denyReason = 'usage_limit_reached'
let paidPlan = true
/** Billed USD the open chat turn has accumulated but not charged yet. */
let pendingTurnUsd = 0
const balanceChecks: number[] = []
const consumeCalls: any[] = []

const billingStub = () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  hasBalance: async (_ws: string, required = 0.001) => required <= availableUsd,
  checkUsageBalance: async (_ws: string, required = 0.001) => {
    balanceChecks.push(required)
    return required <= availableUsd
      ? { ok: true as const }
      : { ok: false as const, reason: denyReason }
  },
  usageLimitErrorPayload: (reason?: string) => ({
    code: reason ?? 'usage_limit_reached',
    message: 'Usage limit reached. Enable usage-based pricing or upgrade your plan.',
  }),
  hasAdvancedModelAccess: async () => true,
  hasPaidSubscription: async () => paidPlan,
  resolveBillingWorkspaceId: async (workspaceId: string) => workspaceId,
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => null,
  ensureSystemWorkspace: async () => ({}),
  canRunTechStackOnInstanceSize: async () => ({ ok: true }),
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
})
mock.module('../services/billing.service', billingStub)
mock.module('../services/billing-runtime', billingStub)

mock.module('../lib/proxy-billing-session-runtime', () => ({
  openSession: async () => {},
  closeSession: async () => ({ billedUsd: 0, rawUsd: 0, totalTokens: 0 }),
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  accumulateVideoUsage: async () => false,
  accumulate3dUsage: async () => false,
  accumulateMusicUsage: async () => false,
  getPendingBilledUsd: async () => pendingTurnUsd,
  setQualitySignals: async () => false,
  recordTurnUsage: async () => ({ billedUsd: 0, rawUsd: 0, totalTokens: 0 }),
}))

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
const { sumHolds, releaseHold, _testing: holdTesting } = await import('../lib/media-spend-hold')
const { calculateImageUsageCost, calculateMusicUsageCost } = await import('../lib/usage-cost')
const { MUSIC_MODEL_CATALOG } = await import('@shogo/model-catalog')

const app = new Hono()
app.route('/api', aiProxyRoutes())
let TOKEN: string
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

const call = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://x/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as any),
    },
  }))

const postJson = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await call(path, { method: 'POST', body: JSON.stringify(body), headers })
  return { res, data: (await res.json()) as any }
}

/** Billing is fire-and-forget; let the microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  routes = []
  fetchLog = []
  balanceChecks.length = 0
  consumeCalls.length = 0
  availableUsd = Number.POSITIVE_INFINITY
  denyReason = 'usage_limit_reached'
  paidPlan = true
  pendingTurnUsd = 0
  holdTesting.localHolds.clear()
  holdTesting.localLocks.clear()
})

// =============================================================================
// 1. Video needs a paid plan
// =============================================================================

describe('video needs a paid plan', () => {
  const submit = (body: Record<string, unknown> = {}) =>
    postJson('/ai/v1/videos/generations', { prompt: 'a wave at dusk', ...body })

  test('a free workspace gets 402 video_requires_paid_plan and nothing is uploaded, estimated or submitted', async () => {
    paidPlan = false
    const { res, data } = await submit()
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('video_requires_paid_plan')
    expect(data.error.message).toContain('paid plan')
    expect(fetchLog).toHaveLength(0)
  })

  test('a Genjutsu edit is gated the same way — no source-clip upload happens first', async () => {
    paidPlan = false
    const { res, data } = await submit({
      genjutsu: 'motion_transfer',
      source_video_url: 'https://cdn.test/source.mp4',
      source_duration_seconds: 6,
      reference_images: ['https://cdn.test/ref.png'],
    })
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('video_requires_paid_plan')
    expect(fetchLog).toHaveLength(0)
  })

  test('the gate runs inside an open chat turn too (no turn bypass)', async () => {
    paidPlan = false
    pendingTurnUsd = 0.5
    const { res, data } = await submit()
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('video_requires_paid_plan')
    expect(fetchLog).toHaveLength(0)
  })

  test('a paid workspace is not blocked by this gate — it reaches the price check instead', async () => {
    paidPlan = true
    availableUsd = 0
    // Pricing is free; the job is refused once the quote is known.
    on(/^https:\/\/hf\.test\/estimate\//, () => json({ credits: '5', usd: '2.60' }))
    const { res, data } = await submit()
    expect(res.status).toBe(402)
    expect(data.error.code).not.toBe('video_requires_paid_plan')
    expect(data.error.code).toBe('usage_limit_reached')
    expect(fetchLog.every((f) => f.url.startsWith('https://hf.test/estimate/'))).toBe(true)
  })
})

// =============================================================================
// 2. The catalogue tells a free workspace why video is off
// =============================================================================

describe('GET /ai/v1/media/models marks video for a free workspace', () => {
  test('free: every video entry is available:false / requires paid_plan, and the header says why', async () => {
    paidPlan = false
    const res = await call('/ai/v1/media/models')
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.videos.length).toBeGreaterThan(0)
    for (const model of data.videos) {
      expect(model.available).toBe(false)
      expect(model.requires).toBe('paid_plan')
    }
    expect(data.video_note).toContain('paid plan')
    // Images stay available: a free workspace can still generate them.
    expect(data.images.length).toBeGreaterThan(0)
    expect(data.images.every((m: any) => m.available === undefined)).toBe(true)
  })

  test('paid: no availability flag and no header note', async () => {
    paidPlan = true
    const res = await call('/ai/v1/media/models?kind=video')
    const data = (await res.json()) as any
    for (const model of data.videos) {
      expect(model.available).toBeUndefined()
      expect(model.requires).toBeUndefined()
    }
    expect(data.video_note).toBeUndefined()
  })
})

// =============================================================================
// 3. Nothing is submitted that the workspace cannot pay for
// =============================================================================

/** A Higgsfield image submit→poll→download cycle. */
function mockHiggsfieldImage(endpoint: string, estimatedUsd: string) {
  on(`https://hf.test/estimate/${endpoint}`, () => json({ credits: '1', usd: estimatedUsd }))
  on(`https://hf.test/${endpoint}`, () => json({
    request_id: 'req-img',
    status: 'queued',
    status_url: 'https://hf.test/requests/req-img/status',
    cancel_url: 'https://hf.test/requests/req-img/cancel',
  }))
  on('https://hf.test/requests/req-img/status', () => json({
    status: 'completed',
    request_id: 'req-img',
    images: [{ url: 'https://cdn.test/out.png' }],
  }))
  on('https://cdn.test/out.png', () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
}

describe('a media job is refused before the provider is called when the price does not fit', () => {
  test('image: catalog-priced model (OpenAI) — 402, no image request leaves the process', async () => {
    const price = calculateImageUsageCost('gpt-image-2.5-flare', 'standard', '1024x1024').billedUsd
    availableUsd = price / 2
    const { res, data } = await postJson('/ai/v1/images/generations', {
      prompt: 'a red square',
      model: 'gpt-image-2.5-flare',
    })
    expect(res.status).toBe(402)
    expect(data.error.type).toBe('billing_error')
    // The message names the real price, not a $0.001 probe.
    expect(data.error.message).toContain(`$${price.toFixed(2)}`)
    expect(fetchLog).toHaveLength(0)
  })

  test('image: the hold is taken at the real price and released after the charge', async () => {
    mockHiggsfieldImage('higgsfield-ai/soul/v2/standard', '0.0035')
    // $0.05 of promo credit covers a $0.004 image (the incident's cheap case).
    availableUsd = 0.05
    const { res } = await postJson('/ai/v1/images/generations', { prompt: 'a postcard', model: 'hf-soul-v2' })
    expect(res.status).toBe(200)
    await settle()
    expect(balanceChecks.at(-1)).toBeCloseTo(0.0035 * 1.2, 4)
    // Released: a finished sync job holds nothing.
    expect(await sumHolds('ws-1')).toBe(0)
    // Submitted exactly once, after the estimate.
    expect(fetchLog.filter((f) => f.url === 'https://hf.test/higgsfield-ai/soul/v2/standard')).toHaveLength(1)
  })

  test('music: refused at the per-song price, before Google is called', async () => {
    const price = calculateMusicUsageCost(MUSIC_MODEL_CATALOG['lyria-3-clip'].usdPerRequest).billedUsd
    availableUsd = price - 0.001
    const { res, data } = await postJson('/ai/v1/music/generations', { prompt: 'a lullaby' })
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('usage_limit_reached')
    expect(fetchLog).toHaveLength(0)
  })

  test('video: refused at the quoted clip price, before anything is uploaded or submitted', async () => {
    availableUsd = 0.5
    on(/^https:\/\/hf\.test\/estimate\//, () => json({ credits: '5', usd: '2.60' }))
    const { res, data } = await postJson('/ai/v1/videos/generations', { prompt: 'a slow pan' })
    expect(res.status).toBe(402)
    expect(data.error.message).toContain('$3.12')
    // The estimate is free and is how the price is known; nothing was submitted.
    expect(fetchLog.every((f) => f.url.startsWith('https://hf.test/estimate/'))).toBe(true)
  })

  test('3D: refused at the estimate before a Tripo task is created', async () => {
    availableUsd = 0
    const { res, data } = await postJson('/ai/v1/3d/generations', { prompt: 'a low-poly chair' })
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('usage_limit_reached')
    expect(fetchLog).toHaveLength(0)
  })

  test('inside an open turn the pending session amount counts against the price', async () => {
    const price = calculateImageUsageCost('gpt-image-2.5-flare', 'standard', '1024x1024').billedUsd
    // $2 of room, $2 already spoken for by the turn: a third $1 cannot fit.
    availableUsd = price * 2
    pendingTurnUsd = price * 2
    const refused = await postJson('/ai/v1/images/generations', {
      prompt: 'a red square',
      model: 'gpt-image-2.5-flare',
    }, { 'x-chat-session-id': 'chat-1' })
    expect(refused.res.status).toBe(402)
    expect(fetchLog).toHaveLength(0)

    // The same request fits once the turn's own spend is gone.
    pendingTurnUsd = 0
    on('https://api.openai.com/v1/images/generations', () => json({ data: [{ b64_json: 'AA==' }] }))
    const allowed = await postJson('/ai/v1/images/generations', {
      prompt: 'a red square',
      model: 'gpt-image-2.5-flare',
    }, { 'x-chat-session-id': 'chat-2' })
    expect(allowed.res.status).toBe(200)
  })
})

// =============================================================================
// 4. The incident, as a regression
// =============================================================================

describe('the promo-absorption incident (SHO-310 AC4)', () => {
  test('$0.98 of promo does not pay for a $10.83 Genjutsu job — refused before submit', async () => {
    availableUsd = 0.98
    const endpoint = 'higgsfield-ai/genjutsu/motion-transfer/v1.0'
    on(`https://hf.test/${endpoint}`, () => json({ request_id: 'req-g', status: 'queued', status_url: 'https://hf.test/requests/req-g/status' }))
    const { res, data } = await postJson('/ai/v1/videos/generations', {
      genjutsu: 'motion_transfer',
      source_video_url: 'https://cdn.test/source.mp4',
      source_duration_seconds: 10,
      reference_images: ['https://cdn.test/ref.png'],
      resolution: '720p',
    })
    expect(res.status).toBe(402)
    expect(data.error.message).toContain('costs about')
    expect(fetchLog).toHaveLength(0)
  })
})

// =============================================================================
// 5. Overage
// =============================================================================

describe('overage is the only way past a full window', () => {
  test('a paid workspace with overage live can run a job its windows cannot cover', async () => {
    // `availableUsd` here already models `checkUsageBalance`'s overage branch:
    // the entitlement is live and within the hard cap.
    availableUsd = 100
    mockHiggsfieldImage('higgsfield-ai/soul/v2/standard', '0.0035')
    const { res } = await postJson('/ai/v1/images/generations', { prompt: 'a postcard', model: 'hf-soul-v2' })
    expect(res.status).toBe(200)
  })

  test('overage_payment_pending is reported with its own code', async () => {
    availableUsd = 0
    denyReason = 'overage_payment_pending'
    const { res, data } = await postJson('/ai/v1/images/generations', {
      prompt: 'a postcard',
      model: 'gpt-image-2.5-flare',
    })
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('overage_payment_pending')
  })

  test('overage_cap_reached is reported with its own code', async () => {
    availableUsd = 0
    denyReason = 'overage_cap_reached'
    const { res, data } = await postJson('/ai/v1/music/generations', { prompt: 'a lullaby' })
    expect(res.status).toBe(402)
    expect(data.error.code).toBe('overage_cap_reached')
  })
})

// =============================================================================
// 6. Parallel submits cannot spend the same room twice
// =============================================================================

describe('parallel submits', () => {
  /** A video submit→status cycle whose price is exactly $1 of billed credit. */
  function mockVideo(usdRaw = '0.8333') {
    on(/^https:\/\/hf\.test\/estimate\//, () => json({ credits: '5', usd: usdRaw }))
    on(/^https:\/\/hf\.test\/minimax\//, () => json({
      request_id: 'req-v',
      status: 'queued',
      status_url: 'https://hf.test/requests/req-v/status',
      cancel_url: 'https://hf.test/requests/req-v/cancel',
    }))
  }

  test('5 concurrent $1 submits against $2.50 of room → exactly 2 are submitted', async () => {
    availableUsd = 2.5
    mockVideo()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postJson('/ai/v1/videos/generations', { prompt: 'a wave' })),
    )
    const submitted = results.filter((r) => r.res.status === 200)
    const refused = results.filter((r) => r.res.status === 402)
    expect(submitted).toHaveLength(2)
    expect(refused).toHaveLength(3)
    // Two live reservations, $1 each — the third submit saw them.
    expect(await sumHolds('ws-1')).toBeCloseTo(2, 3)
    expect(fetchLog.filter((f) => f.url.startsWith('https://hf.test/minimax/'))).toHaveLength(2)
  })

  test('a completed job releases its hold, and a finished job never blocks the next one', async () => {
    availableUsd = 2.5
    mockVideo()
    const first = await postJson('/ai/v1/videos/generations', { prompt: 'a wave' })
    const second = await postJson('/ai/v1/videos/generations', { prompt: 'a wave' })
    expect(first.res.status).toBe(200)
    expect(second.res.status).toBe(200)
    expect(await sumHolds('ws-1')).toBeCloseTo(2, 3)

    let status = 'completed'
    on('https://hf.test/requests/req-v/status', () => json({
      status,
      request_id: 'req-v',
      ...(status === 'completed' ? { video: { url: 'https://cdn.test/clip.mp4' } } : {}),
    }))
    const polled = await call(`/ai/v1/videos/${first.data.id}`)
    expect(polled.status).toBe(200)
    await settle()
    expect(await sumHolds('ws-1')).toBeCloseTo(1, 3)
    expect(consumeCalls.some((c) => c.actionType === 'ai_video_generation')).toBe(true)

    status = 'failed'
    const failed = await call(`/ai/v1/videos/${second.data.id}`)
    expect(failed.status).toBe(200)
    expect(await sumHolds('ws-1')).toBe(0)

    // Both finished: a third submit is not blocked by their reservations.
    const third = await postJson('/ai/v1/videos/generations', { prompt: 'a wave' })
    expect(third.res.status).toBe(200)
  })

  test('an expired hold stops counting', async () => {
    availableUsd = 2.5
    const { placeHold } = await import('../lib/media-spend-hold')
    await placeHold('ws-1', 'stale', 2.5, 0)
    await new Promise((r) => setTimeout(r, 5))
    expect(await sumHolds('ws-1')).toBe(0)
    await releaseHold('ws-1', 'stale')
  })
})
