// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * shogo.ai funnel endpoints: shared-secret gate, pre-signup funnel steps with
 * their Conversions API twins, and the F1 try-it (URL → six ad hooks).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

const created: any[] = []
const funnelEventCreate = mock(async ({ data }: any) => {
  if (created.some((r) => r.eventId === data.eventId)) {
    throw Object.assign(new Error('unique'), { code: 'P2002' })
  }
  created.push(data)
  return data
})
mock.module('../../lib/prisma', () => ({ prisma: { funnelEvent: { create: funnelEventCreate } } }))
mock.module('../../lib/tunnel-redis', () => ({ getSharedRedis: () => null }))

const { funnelRoutes, parseHooks, summarizeHtml, _resetFunnelCountersForTests, TRY_PER_IP_PER_DAY } = await import('../funnel')
const { UnsafeUrlError } = await import('../../lib/safe-fetch')

const KEY = 'funnel-secret'
const sentEvents: any[] = []
const sendEvent = mock(async (e: any) => {
  sentEvents.push(e)
  return { sent: true }
})

const SIX = JSON.stringify({
  business: 'Hand-poured candles for gift buyers',
  hooks: ['pain', 'proof', 'offer', 'curiosity', 'contrast', 'story'].map((angle, i) => ({
    hook: `Hook ${i + 1}`,
    angle,
    format: 'static',
  })),
})

function app(over: Partial<Parameters<typeof funnelRoutes>[0]> = {}) {
  return funnelRoutes({
    sendEvent,
    fetchPage: (async (url: string) => ({
      url,
      status: 200,
      contentType: 'text/html',
      body: '<html><head><title>Ember Candles</title><meta name="description" content="Hand-poured soy candles"></head><body><h1>Gifts that glow</h1><script>x()</script></body></html>',
    })) as any,
    generateHooks: async () => '```json\n' + SIX + '\n```',
    ...over,
  })
}

const post = (a: ReturnType<typeof funnelRoutes>, path: string, body: unknown, key: string | null = KEY) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-shogo-funnel-key': key } : {}) },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  process.env.SHOGO_FUNNEL_KEY = KEY
  delete process.env.SHOGO_FUNNEL_TRY_DAILY_CAP
  created.length = 0
  sentEvents.length = 0
  _resetFunnelCountersForTests()
})

describe('shared-secret gate', () => {
  test('no key configured: 503, nothing exposed', async () => {
    delete process.env.SHOGO_FUNNEL_KEY
    const res = await post(app(), '/funnel/events', {})
    expect(res.status).toBe(503)
  })

  test('missing or wrong key: 401', async () => {
    expect((await post(app(), '/funnel/events', {}, null)).status).toBe(401)
    expect((await post(app(), '/funnel/events', {}, 'nope')).status).toBe(401)
  })
})

describe('POST /funnel/events', () => {
  const event = {
    eventId: 'lead_abc',
    funnel: 'f1',
    step: 'result',
    visitorId: 'v1',
    utmSource: 'meta',
    utmContent: 'ad-7',
    email: 'Lead@Example.com',
    fbp: 'fb.1.1.1',
    clientIp: '203.0.113.5',
    sourceUrl: 'https://shogo.ai/for/meta-ads',
  }

  test('records the step and sends its Meta twin with the same event id', async () => {
    const res = await post(app(), '/funnel/events', event)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: false })
    expect(created[0]).toMatchObject({ eventId: 'lead_abc', funnel: 'f1', step: 'result', utmContent: 'ad-7' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sentEvents[0]).toMatchObject({ name: 'Lead', eventId: 'lead_abc', sourceUrl: 'https://shogo.ai/for/meta-ads' })
    expect(sentEvents[0].user).toMatchObject({ email: 'Lead@Example.com', fbp: 'fb.1.1.1', clientIp: '203.0.113.5' })
  })

  test('view → ViewContent, start → FunnelStart', async () => {
    await post(app(), '/funnel/events', { ...event, eventId: 'v_1', step: 'view' })
    await post(app(), '/funnel/events', { ...event, eventId: 's_1', step: 'start' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sentEvents.map((e) => e.name)).toEqual(['ViewContent', 'FunnelStart'])
  })

  test('a retried beacon is a duplicate, not a second event', async () => {
    await post(app(), '/funnel/events', event)
    const res = await post(app(), '/funnel/events', event)
    expect(await res.json()).toEqual({ ok: true, duplicate: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(sentEvents).toHaveLength(1)
  })

  test('rejects unknown funnels and steps', async () => {
    expect((await post(app(), '/funnel/events', { ...event, funnel: 'f9' })).status).toBe(400)
    expect((await post(app(), '/funnel/events', { ...event, step: 'purchase' })).status).toBe(400)
    expect((await post(app(), '/funnel/events', { funnel: 'f1' })).status).toBe(400)
    expect(created).toHaveLength(0)
  })
})

describe('POST /funnel/try/ad-hooks', () => {
  test('returns six hooks for the site', async () => {
    const res = await post(app(), '/funnel/try/ad-hooks', { url: 'embercandles.com', clientIp: '198.51.100.1' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://embercandles.com')
    expect(body.siteTitle).toBe('Ember Candles')
    expect(body.business).toBe('Hand-poured candles for gift buyers')
    expect(body.hooks).toHaveLength(6)
  })

  test(`limits each visitor IP to ${TRY_PER_IP_PER_DAY} tries a day`, async () => {
    const a = app()
    for (let i = 0; i < TRY_PER_IP_PER_DAY; i++) {
      expect((await post(a, '/funnel/try/ad-hooks', { url: 'x.com', clientIp: '198.51.100.2' })).status).toBe(200)
    }
    const res = await post(a, '/funnel/try/ad-hooks', { url: 'x.com', clientIp: '198.51.100.2' })
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
    expect((await post(a, '/funnel/try/ad-hooks', { url: 'x.com', clientIp: '198.51.100.3' })).status).toBe(200)
  })

  test('the platform-wide daily cap holds', async () => {
    process.env.SHOGO_FUNNEL_TRY_DAILY_CAP = '1'
    const a = app()
    expect((await post(a, '/funnel/try/ad-hooks', { url: 'x.com', clientIp: '1.1.1.1' })).status).toBe(200)
    const res = await post(a, '/funnel/try/ad-hooks', { url: 'x.com', clientIp: '2.2.2.2' })
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('daily_cap')
  })

  test('an internal address is refused with a readable error', async () => {
    const res = await post(
      app({ fetchPage: (async () => { throw new UnsafeUrlError('private') }) as any }),
      '/funnel/try/ad-hooks',
      { url: 'http://169.254.169.254/latest', clientIp: '1.1.1.9' },
    )
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('That address is not a public website.')
  })

  test('a model answer with no usable hooks is a 502, not a crash', async () => {
    const res = await post(app({ generateHooks: async () => 'sorry' }), '/funnel/try/ad-hooks', { url: 'x.com', clientIp: '1.1.1.8' })
    expect(res.status).toBe(502)
  })

  test('missing url is a 400', async () => {
    expect((await post(app(), '/funnel/try/ad-hooks', { clientIp: '1.1.1.7' })).status).toBe(400)
  })
})

describe('helpers', () => {
  test('summarizeHtml keeps title, description and visible text only', () => {
    const s = summarizeHtml('<title> A  B </title><meta name="description" content="Desc"><style>.x{}</style><p>Hello &amp; welcome</p>')
    expect(s).toEqual({ title: 'A B', description: 'Desc', text: 'A B Hello & welcome' })
  })

  test('parseHooks tolerates prose around the JSON and needs at least 3 hooks', () => {
    expect(parseHooks('Here you go: ' + SIX + ' Enjoy')!.hooks).toHaveLength(6)
    expect(parseHooks(JSON.stringify({ hooks: [{ hook: 'one' }] }))).toBeNull()
    expect(parseHooks('no json')).toBeNull()
  })
})
