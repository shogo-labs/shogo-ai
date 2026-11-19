// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, mock } from 'bun:test'
import {
  metaCapiConfig,
  sha256Normalized,
  buildUserData,
  buildPayload,
  sendMetaEvents,
  clientIpFromHeaders,
  fbcFrom,
} from '../meta-capi'

describe('metaCapiConfig', () => {
  test('is off until both a pixel id and a token exist', () => {
    expect(metaCapiConfig({} as any)).toBeNull()
    expect(metaCapiConfig({ META_PIXEL_ID: '1' } as any)).toBeNull()
    expect(metaCapiConfig({ FB_PIXEL_ID: 'FB_PIXEL_ID_PLACEHOLDER', META_CAPI_TOKEN: 't' } as any)).toBeNull()
    expect(metaCapiConfig({ FB_PIXEL_ID: '42', META_CAPI_TOKEN: 't' } as any)).toEqual({
      pixelId: '42',
      token: 't',
      testEventCode: undefined,
    })
  })
})

describe('user data', () => {
  test('hashes email and external id after normalizing, keeps browser ids raw', () => {
    expect(sha256Normalized('  Foo@Bar.com ')).toBe(sha256Normalized('foo@bar.com'))
    expect(sha256Normalized('')).toBeUndefined()
    const ud = buildUserData({ email: 'a@b.co', externalId: 'u1', fbp: 'fb.1.2.3', clientIp: '1.2.3.4', userAgent: 'UA' })
    expect((ud.em as string[])[0]).toMatch(/^[0-9a-f]{64}$/)
    expect((ud.external_id as string[])[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(ud.fbp).toBe('fb.1.2.3')
    expect(ud.client_ip_address).toBe('1.2.3.4')
    expect(ud.client_user_agent).toBe('UA')
    expect(ud.fbc).toBeUndefined()
  })
})

describe('buildPayload', () => {
  test('website action source, event id, and the test code only when set', () => {
    const p = buildPayload(
      [{ name: 'Lead', eventId: 'e1', user: {}, sourceUrl: 'https://shogo.ai/x', customData: { funnel: 'f1' } }],
      { pixelId: '1', token: 't', testEventCode: 'T1' },
    ) as any
    expect(p.test_event_code).toBe('T1')
    expect(p.data[0]).toMatchObject({ event_name: 'Lead', event_id: 'e1', action_source: 'website', event_source_url: 'https://shogo.ai/x' })
    expect(p.data[0].custom_data).toEqual({ funnel: 'f1' })
    const q = buildPayload([{ name: 'Lead', eventId: 'e2', user: {} }], { pixelId: '1', token: 't' }) as any
    expect(q.test_event_code).toBeUndefined()
    expect(q.data[0].custom_data).toBeUndefined()
  })
})

describe('sendMetaEvents', () => {
  const cfg = { pixelId: '99', token: 'tok' }

  test('no config is a quiet no-op', async () => {
    const fetchImpl = mock(async () => new Response('{}'))
    expect(await sendMetaEvents([{ name: 'Lead', eventId: 'e', user: {} }], { config: null, fetchImpl: fetchImpl as any })).toEqual({ sent: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('posts to the pixel\'s events edge and reports events_received', async () => {
    let url = ''
    const fetchImpl = mock(async (u: any) => {
      url = String(u)
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    })
    const res = await sendMetaEvents([{ name: 'Activated', eventId: 'a', user: {} }], { config: cfg, fetchImpl: fetchImpl as any })
    expect(res).toEqual({ sent: true, status: 200, eventsReceived: 1 })
    expect(url).toStartWith('https://graph.facebook.com/v21.0/99/events?access_token=tok')
  })

  test('a Graph API error or a network failure resolves, never throws', async () => {
    const rejected = await sendMetaEvents([{ name: 'Lead', eventId: 'e', user: {} }], {
      config: cfg,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 400 })) as any,
    })
    expect(rejected).toEqual({ sent: false, status: 400, error: 'Invalid token' })
    const down = await sendMetaEvents([{ name: 'Lead', eventId: 'e', user: {} }], {
      config: cfg,
      fetchImpl: (async () => { throw new Error('ECONNRESET') }) as any,
    })
    expect(down.sent).toBe(false)
    expect(down.error).toContain('ECONNRESET')
  })
})

describe('request helpers', () => {
  test('client ip prefers Cloudflare, then the first forwarded hop', () => {
    const h = (m: Record<string, string>) => (n: string) => m[n] ?? null
    expect(clientIpFromHeaders(h({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1')
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }))).toBe('2.2.2.2')
    expect(clientIpFromHeaders(h({}))).toBeNull()
  })

  test('fbc: the cookie wins, else built from fbclid', () => {
    expect(fbcFrom('fb.1.5.x', 'y')).toBe('fb.1.5.x')
    expect(fbcFrom(null, 'clk')).toMatch(/^fb\.1\.\d+\.clk$/)
    expect(fbcFrom(null, null)).toBeNull()
  })
})
