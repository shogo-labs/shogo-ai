// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the SERVER_BACKED Workers KV helper used by the publish flow to
// flag / unflag server-backed subdomains. The *.shogo.one worker reads this
// flag to decide whether to proxy /api/* at all and, via the value, which
// backend to send it to (`knative` = Kourier, `metal` = API published
// endpoint), so the exact CF KV REST shape (and the "best-effort no-op when
// unconfigured" contract) matters.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getServerBackedKvConfig,
  getServerBackedFlag,
  setServerBackedFlag,
  getServerBackedBackend,
  getServerBackedRegion,
  parseServerBackedValue,
  clearServerBackedFlag,
} from '../lib/cloudflare-server-backed-kv'
import { getPreviewRegionCode } from '../lib/cloudflare-preview-region-kv'
import { REGION_CODE_BY_ID, getRegionCode } from '../lib/region'

const ENV_KEYS = [
  'CF_API_TOKEN',
  'CF_CUSTOM_HOSTNAMES_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_SERVER_BACKED_KV_NAMESPACE_ID',
  'REGION_ID',
] as const

let saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch
let calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = []

function installFetch(status = 200, responseBody = '{"success":true}') {
  calls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: (init?.body as string) ?? null,
      auth: (init?.headers as Record<string, string>)?.['Authorization'] ?? null,
    })
    return new Response(responseBody, { status })
  }) as typeof fetch
}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  globalThis.fetch = realFetch
})

function configure() {
  process.env.CF_API_TOKEN = 'cf-token-123'
  process.env.CF_ACCOUNT_ID = 'acct-abc'
  process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'ns-xyz'
}

describe('getServerBackedKvConfig', () => {
  test('returns null until token + account + namespace are all set', () => {
    expect(getServerBackedKvConfig()).toBeNull()
    process.env.CF_API_TOKEN = 't'
    expect(getServerBackedKvConfig()).toBeNull()
    process.env.CF_ACCOUNT_ID = 'a'
    expect(getServerBackedKvConfig()).toBeNull()
    process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'n'
    expect(getServerBackedKvConfig()).not.toBeNull()
  })

  test('accepts CF_CUSTOM_HOSTNAMES_TOKEN as the token fallback', () => {
    process.env.CF_CUSTOM_HOSTNAMES_TOKEN = 't'
    process.env.CF_ACCOUNT_ID = 'a'
    process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'n'
    expect(getServerBackedKvConfig()).not.toBeNull()
  })
})

describe('setServerBackedFlag', () => {
  test('is a no-op (returns false) when unconfigured — never fails a publish', async () => {
    installFetch()
    expect(await setServerBackedFlag('my-app')).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('PUTs the default `knative` backend to the subdomain key with the bearer token', async () => {
    configure()
    installFetch()
    const ok = await setServerBackedFlag('august-29th-celebration-portal')
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-abc/storage/kv/namespaces/ns-xyz/values/august-29th-celebration-portal',
    )
    expect(calls[0].body).toBe('knative')
    expect(calls[0].auth).toBe('Bearer cf-token-123')
  })

  test('PUTs `metal` when the subdomain routes to the API published endpoint', async () => {
    configure()
    installFetch()
    const ok = await setServerBackedFlag('my-app', 'metal')
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].body).toBe('metal')
  })

  test('returns false (best-effort) when Cloudflare responds non-2xx', async () => {
    configure()
    installFetch(500)
    expect(await setServerBackedFlag('my-app')).toBe(false)
  })

  // SHO-588: the Worker has one Kourier per region, and a Knative app's ksvc +
  // DomainMapping only exist in its home region's cluster, so the value must
  // say which one. Without the code every EU app was sent to US Kourier → 404.
  test('stamps this pod`s region code into the knative value', async () => {
    configure()
    process.env.REGION_ID = 'eu-frankfurt-1'
    installFetch()
    expect(await setServerBackedFlag('eu-app')).toBe(true)
    expect(calls[0].body).toBe('knative:eu')

    process.env.REGION_ID = 'us-ashburn-1'
    installFetch()
    await setServerBackedFlag('us-app')
    expect(calls[0].body).toBe('knative:us')
  })

  test('writes bare `knative` with no region (local/desktop, unknown REGION_ID)', async () => {
    configure()
    process.env.REGION_ID = 'some-future-region-9'
    installFetch()
    expect(await setServerBackedFlag('local-app')).toBe(true)
    expect(calls[0].body).toBe('knative')
  })

  test('takes an explicit region code for callers outside a pod', async () => {
    configure()
    installFetch()
    expect(await setServerBackedFlag('swept-app', 'knative', 'eu')).toBe(true)
    expect(calls[0].body).toBe('knative:eu')
    // An explicit null means "no region" even on a regional pod.
    process.env.REGION_ID = 'us-ashburn-1'
    installFetch()
    await setServerBackedFlag('swept-app', 'knative', null)
    expect(calls[0].body).toBe('knative')
  })

  test('never stamps a region onto a metal value — the API routes those', async () => {
    configure()
    process.env.REGION_ID = 'eu-frankfurt-1'
    installFetch()
    await setServerBackedFlag('metal-app', 'metal')
    expect(calls[0].body).toBe('metal')
  })
})

describe('getServerBackedBackend', () => {
  test('normalizes the legacy `1` value to the knative backend', async () => {
    configure()
    installFetch(200, '1')
    expect(await getServerBackedBackend('my-app')).toBe('knative')
  })

  test('reads `metal` back as the metal backend', async () => {
    configure()
    installFetch(200, 'metal')
    expect(await getServerBackedBackend('my-app')).toBe('metal')
  })

  test('returns null for an unflagged (static, edge-only) subdomain', async () => {
    configure()
    installFetch(404, '')
    expect(await getServerBackedBackend('my-app')).toBeNull()
  })
})

describe('getServerBackedFlag', () => {
  test('is true for a region-stamped knative app', async () => {
    configure()
    installFetch(200, 'knative:eu')
    expect(await getServerBackedFlag('my-app')).toBe(true)
  })

  test('a 404 is a known `false` (static app)', async () => {
    configure()
    installFetch(404, '')
    expect(await getServerBackedFlag('my-app')).toBe(false)
  })

  // The publish panel treats `null` as "unknown, assume server-backed". A read
  // error must stay `null` — never `false`, which would claim the app is static.
  test('a read error stays unknown, not false', async () => {
    configure()
    installFetch(500, '')
    expect(await getServerBackedFlag('my-app')).toBeNull()
  })

  test('unconfigured is unknown', async () => {
    installFetch(200, 'knative')
    expect(await getServerBackedFlag('my-app')).toBeNull()
  })
})

describe('parseServerBackedValue / getServerBackedRegion', () => {
  test('parses every value the Worker accepts', () => {
    expect(parseServerBackedValue('knative:eu')).toEqual({ backend: 'knative', region: 'eu' })
    expect(parseServerBackedValue('KNATIVE:EU')).toEqual({ backend: 'knative', region: 'eu' })
    expect(parseServerBackedValue('knative')).toEqual({ backend: 'knative', region: null })
    expect(parseServerBackedValue('1')).toEqual({ backend: 'knative', region: null })
    // Uniform format, but metal ignores the code.
    expect(parseServerBackedValue('metal:eu')).toEqual({ backend: 'metal', region: null })
    expect(parseServerBackedValue('metal')).toEqual({ backend: 'metal', region: null })
    expect(parseServerBackedValue('')).toEqual({ backend: null, region: null })
    expect(parseServerBackedValue(null)).toEqual({ backend: null, region: null })
  })

  test('still reports a stamped app as the knative backend', async () => {
    configure()
    installFetch(200, 'knative:eu')
    expect(await getServerBackedBackend('my-app')).toBe('knative')
    expect(await getServerBackedRegion('my-app')).toBe('eu')
  })

  test('reports no region for an un-stamped knative or a metal entry', async () => {
    configure()
    installFetch(200, 'knative')
    expect(await getServerBackedRegion('my-app')).toBeNull()
    installFetch(200, 'metal')
    expect(await getServerBackedRegion('my-app')).toBeNull()
  })
})

describe('one REGION_CODE_BY_ID', () => {
  test('the preview-router and the SERVER_BACKED stamp resolve regions identically', () => {
    for (const regionId of Object.keys(REGION_CODE_BY_ID)) {
      process.env.REGION_ID = regionId
      expect(getPreviewRegionCode()).toBe(REGION_CODE_BY_ID[regionId])
      expect(getRegionCode()).toBe(REGION_CODE_BY_ID[regionId])
    }
    delete process.env.REGION_ID
    expect(getPreviewRegionCode()).toBeNull()
    expect(getRegionCode()).toBeNull()
  })

  test('the preview KV module does not define a second map', () => {
    const src = readFileSync(resolve(import.meta.dir, '../lib/cloudflare-preview-region-kv.ts'), 'utf8')
    // No declaration (only a comment reference is fine); it must import the one
    // map from lib/region.ts instead.
    expect(src).not.toMatch(/REGION_CODE_BY_ID\s*[:=]/)
    expect(src).toContain("from './region'")
  })

  test('warns nothing about a region it cannot map', () => {
    expect(REGION_CODE_BY_ID['ap-mumbai-1']).toBeUndefined()
  })
})

describe('clearServerBackedFlag', () => {
  test('DELETEs the subdomain key', async () => {
    configure()
    installFetch()
    const ok = await clearServerBackedFlag('my-app')
    expect(ok).toBe(true)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-abc/storage/kv/namespaces/ns-xyz/values/my-app',
    )
  })

  test('treats a 404 (already gone) as success', async () => {
    configure()
    installFetch(404)
    expect(await clearServerBackedFlag('my-app')).toBe(true)
  })
})
