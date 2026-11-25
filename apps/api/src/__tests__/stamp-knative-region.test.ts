// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-588: the sweep that backfills the home region onto existing SERVER_BACKED
// entries. The decision is deliberately conservative — it writes only when the
// workspace's home region and the Kourier probe agree — so it is worth pinning
// case by case. Everything here is pure or mocked: no Cloudflare call is made.

import { afterEach, describe, expect, test } from 'bun:test'
import { decideStamp, probeKourierReady } from '../../scripts/stamp-knative-region'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('decideStamp', () => {
  test('stamps the code when only the home region answers', () => {
    expect(decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: 404, eu: 401 } })).toMatchObject({
      action: 'write',
      region: 'eu',
      value: 'knative:eu',
    })
    expect(decideStamp({ value: 'knative', homeRegion: 'us-ashburn-1', probes: { us: 401, eu: 404 } })).toMatchObject({
      action: 'write',
      region: 'us',
      value: 'knative:us',
    })
  })

  test('treats the legacy `1` like a bare knative', () => {
    expect(decideStamp({ value: '1', homeRegion: 'eu-frankfurt-1', probes: { us: 404, eu: 200 } })).toMatchObject({
      action: 'write',
      value: 'knative:eu',
    })
  })

  test('a legacy row with no homeRegion defaults to the primary region', () => {
    expect(decideStamp({ value: 'knative', homeRegion: null, probes: { us: 401, eu: 404 } })).toMatchObject({
      action: 'write',
      region: 'us',
      value: 'knative:us',
    })
  })

  test('leaves an entry alone when both Kouriers answer', () => {
    expect(decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: 401, eu: 401 } }).action).toBe(
      'report',
    )
  })

  test('leaves an entry alone when neither Kourier answers', () => {
    expect(decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: 404, eu: 404 } }).action).toBe(
      'report',
    )
    expect(decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: null, eu: null } }).action).toBe(
      'report',
    )
  })

  test('refuses to write when the probe disagrees with homeRegion', () => {
    const decision = decideStamp({ value: 'knative', homeRegion: 'eu-frankfurt-1', probes: { us: 401, eu: 404 } })
    expect(decision.action).toBe('report')
    if (decision.action === 'report') expect(decision.reason).toContain('probe says us')
  })

  test('skips metal, already-stamped and unrecognised entries', () => {
    expect(decideStamp({ value: 'metal', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
    expect(decideStamp({ value: 'metal:eu', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
    expect(decideStamp({ value: 'knative:eu', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
    expect(decideStamp({ value: '', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
    expect(decideStamp({ value: 'something-else', homeRegion: 'eu-frankfurt-1', probes: {} }).action).toBe('skip')
  })

  test('reports a home region with no edge anchor instead of guessing', () => {
    const decision = decideStamp({ value: 'knative', homeRegion: 'ap-mumbai-1', probes: { us: 401, eu: 404 } })
    expect(decision.action).toBe('report')
    if (decision.action === 'report') expect(decision.reason).toContain('no edge anchor')
  })
})

describe('probeKourierReady', () => {
  test('asks one region`s Kourier for /ready under the app`s own Host', async () => {
    const calls: Array<{ url: string; host: string | undefined }> = []
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), host: (init?.headers as Record<string, string>)?.Host })
      return new Response('ok', { status: 401 })
    }) as unknown as typeof fetch

    expect(await probeKourierReady('79.76.126.115', 'play-samsara-api.shogo.one')).toBe(401)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://79.76.126.115/ready')
    expect(calls[0].host).toBe('play-samsara-api.shogo.one')
  })

  test('reports a 404 as 404 (this region has no DomainMapping), not as "no answer"', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    expect(await probeKourierReady('152.70.192.220', 'play-samsara-api.shogo.one')).toBe(404)
  })

  test('reports null when the region cannot be reached', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeKourierReady('152.70.192.220', 'play-samsara-api.shogo.one')).toBeNull()
  })
})
