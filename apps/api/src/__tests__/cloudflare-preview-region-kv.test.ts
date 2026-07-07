// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the PREVIEW_REGIONS Workers KV helper. The `preview--*.shogo.ai`
// router Worker reads `projectId -> region` from this namespace to
// resolveOverride each preview to its hosting region's Kourier LB, so the exact
// CF KV REST shape, the region-code derivation from REGION_ID, and the
// "best-effort no-op when unconfigured" contract all matter.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getPreviewRegionCode,
  getPreviewRegionKvConfig,
  setPreviewRegion,
  clearPreviewRegion,
} from '../lib/cloudflare-preview-region-kv'

const ENV_KEYS = [
  'CF_API_TOKEN',
  'CF_CUSTOM_HOSTNAMES_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_PREVIEW_REGIONS_KV_NAMESPACE_ID',
  'REGION_ID',
] as const

let saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch
let calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = []

function installFetch(status = 200) {
  calls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: (init?.body as string) ?? null,
      auth: (init?.headers as Record<string, string>)?.['Authorization'] ?? null,
    })
    return new Response('{"success":true}', { status })
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

function configure(regionId = 'eu-frankfurt-1') {
  process.env.CF_CUSTOM_HOSTNAMES_TOKEN = 'cf-kv-token'
  process.env.CF_ACCOUNT_ID = 'acct-abc'
  process.env.CF_PREVIEW_REGIONS_KV_NAMESPACE_ID = 'ns-preview'
  process.env.REGION_ID = regionId
}

describe('getPreviewRegionCode', () => {
  test('maps known REGION_IDs to short codes', () => {
    process.env.REGION_ID = 'us-ashburn-1'
    expect(getPreviewRegionCode()).toBe('us')
    process.env.REGION_ID = 'eu-frankfurt-1'
    expect(getPreviewRegionCode()).toBe('eu')
    process.env.REGION_ID = 'staging'
    expect(getPreviewRegionCode()).toBe('staging')
  })

  test('returns null when REGION_ID is unset or unrecognized', () => {
    expect(getPreviewRegionCode()).toBeNull()
    process.env.REGION_ID = 'some-future-region-9'
    expect(getPreviewRegionCode()).toBeNull()
  })
})

describe('getPreviewRegionKvConfig', () => {
  test('returns null until token + account + namespace are all set', () => {
    expect(getPreviewRegionKvConfig()).toBeNull()
    process.env.CF_API_TOKEN = 't'
    expect(getPreviewRegionKvConfig()).toBeNull()
    process.env.CF_ACCOUNT_ID = 'a'
    expect(getPreviewRegionKvConfig()).toBeNull()
    process.env.CF_PREVIEW_REGIONS_KV_NAMESPACE_ID = 'n'
    expect(getPreviewRegionKvConfig()).not.toBeNull()
  })

  test('prefers the KV-capable CF_CUSTOM_HOSTNAMES_TOKEN over CF_API_TOKEN', () => {
    process.env.CF_API_TOKEN = 'dns-only'
    process.env.CF_CUSTOM_HOSTNAMES_TOKEN = 'kv-capable'
    process.env.CF_ACCOUNT_ID = 'a'
    process.env.CF_PREVIEW_REGIONS_KV_NAMESPACE_ID = 'n'
    expect(getPreviewRegionKvConfig()?.apiToken).toBe('kv-capable')
  })
})

describe('setPreviewRegion', () => {
  test('is a no-op (returns false) when unconfigured — never fails a DomainMapping create', async () => {
    installFetch()
    expect(await setPreviewRegion('proj-1')).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('is a no-op when REGION_ID is unmappable even if KV is configured', async () => {
    process.env.CF_CUSTOM_HOSTNAMES_TOKEN = 'cf-kv-token'
    process.env.CF_ACCOUNT_ID = 'acct-abc'
    process.env.CF_PREVIEW_REGIONS_KV_NAMESPACE_ID = 'ns-preview'
    // REGION_ID intentionally unset
    installFetch()
    expect(await setPreviewRegion('proj-1')).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('PUTs the region code to the projectId key with the bearer token', async () => {
    configure('eu-frankfurt-1')
    installFetch()
    const ok = await setPreviewRegion('03a21b6f-e906-4926-b625-e46a3fbd5d18')
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-abc/storage/kv/namespaces/ns-preview/values/03a21b6f-e906-4926-b625-e46a3fbd5d18',
    )
    expect(calls[0].body).toBe('eu')
    expect(calls[0].auth).toBe('Bearer cf-kv-token')
  })

  test('returns false (best-effort) when Cloudflare responds non-2xx', async () => {
    configure()
    installFetch(500)
    expect(await setPreviewRegion('proj-1')).toBe(false)
  })
})

describe('clearPreviewRegion', () => {
  test('DELETEs the projectId key', async () => {
    configure()
    installFetch()
    const ok = await clearPreviewRegion('proj-1')
    expect(ok).toBe(true)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-abc/storage/kv/namespaces/ns-preview/values/proj-1',
    )
  })

  test('treats a 404 (already gone) as success', async () => {
    configure()
    installFetch(404)
    expect(await clearPreviewRegion('proj-1')).toBe(true)
  })

  test('does not require REGION_ID (deletion is region-agnostic)', async () => {
    process.env.CF_CUSTOM_HOSTNAMES_TOKEN = 'cf-kv-token'
    process.env.CF_ACCOUNT_ID = 'acct-abc'
    process.env.CF_PREVIEW_REGIONS_KV_NAMESPACE_ID = 'ns-preview'
    // REGION_ID unset — clear must still work to clean up any region's entry.
    installFetch()
    expect(await clearPreviewRegion('proj-1')).toBe(true)
    expect(calls.length).toBe(1)
  })
})
