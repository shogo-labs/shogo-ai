// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/cloudflare-dns.ts — Cloudflare API DNS helper for
 * preview hostnames. The module owns three exports:
 *
 *  - getCloudflareDnsConfig() — env-driven config + module-level cache
 *  - upsertPreviewDnsRecord() — idempotent create/update A record
 *  - deletePreviewDnsRecord() — best-effort delete
 *
 * All Cloudflare HTTP I/O is fed through a fakeFetch passed via
 * cfg.fetch. We avoid going through `globalThis.fetch` entirely.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  _resetCloudflareDnsConfigForTest,
  deletePreviewDnsRecord,
  getCloudflareDnsConfig,
  upsertPreviewDnsRecord,
} from '../lib/cloudflare-dns'

// ─── env scaffolding ──────────────────────────────────────────────────────

const ENV_KEYS = ['CF_API_TOKEN', 'CF_ZONE_ID', 'KOURIER_LB_IP', 'CF_DNS_COMMENT'] as const
const SAVED: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
  _resetCloudflareDnsConfigForTest()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
  _resetCloudflareDnsConfigForTest()
})

// ─── fake fetch helpers ───────────────────────────────────────────────────

type Resp = { ok?: boolean; result?: unknown; errors?: Array<{ code: number; message: string }> }

interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
}

function makeFakeFetch(responder: (call: FakeCall) => Resp) {
  const calls: FakeCall[] = []
  const fetchImpl = (async (url: string, init: any = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}))
    const body = init.body ? JSON.parse(init.body as string) : undefined
    const call: FakeCall = { url, method: init.method ?? 'GET', headers, body }
    calls.push(call)
    const r = responder(call)
    return {
      json: async () => ({
        success: r.ok ?? true,
        errors: r.errors ?? [],
        result: r.result ?? null,
      }),
    } as any
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, calls }
}

function setEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.CF_API_TOKEN = over.CF_API_TOKEN ?? 'cf-token'
  process.env.CF_ZONE_ID = over.CF_ZONE_ID ?? 'zone-abc'
  process.env.KOURIER_LB_IP = over.KOURIER_LB_IP ?? '10.0.0.1'
  if (over.CF_DNS_COMMENT) process.env.CF_DNS_COMMENT = over.CF_DNS_COMMENT
  _resetCloudflareDnsConfigForTest()
}

// ─── getCloudflareDnsConfig ───────────────────────────────────────────────

describe('getCloudflareDnsConfig', () => {
  test('returns null when CF_API_TOKEN is missing', () => {
    process.env.CF_ZONE_ID = 'z'
    process.env.KOURIER_LB_IP = '1.1.1.1'
    expect(getCloudflareDnsConfig()).toBeNull()
  })

  test('returns null when CF_ZONE_ID is missing', () => {
    process.env.CF_API_TOKEN = 't'
    process.env.KOURIER_LB_IP = '1.1.1.1'
    expect(getCloudflareDnsConfig()).toBeNull()
  })

  test('returns null when KOURIER_LB_IP is missing', () => {
    process.env.CF_API_TOKEN = 't'
    process.env.CF_ZONE_ID = 'z'
    expect(getCloudflareDnsConfig()).toBeNull()
  })

  test('returns config when all three env vars are set', () => {
    setEnv()
    const cfg = getCloudflareDnsConfig()
    expect(cfg).toEqual({
      apiToken: 'cf-token',
      zoneId: 'zone-abc',
      lbIp: '10.0.0.1',
      comment: 'shogo-preview (managed by api)',
    })
  })

  test('honors CF_DNS_COMMENT override', () => {
    setEnv({ CF_DNS_COMMENT: 'staging-env' })
    expect(getCloudflareDnsConfig()?.comment).toBe('staging-env')
  })

  test('caches the result — flipping env after the first call does NOT change the answer', () => {
    setEnv()
    const first = getCloudflareDnsConfig()
    expect(first).not.toBeNull()
    delete process.env.CF_API_TOKEN
    // Cache lives until _resetCloudflareDnsConfigForTest fires (or process restart).
    expect(getCloudflareDnsConfig()).toBe(first as any)
  })

  test('_resetCloudflareDnsConfigForTest re-reads env on next call', () => {
    setEnv()
    expect(getCloudflareDnsConfig()).not.toBeNull()
    delete process.env.CF_API_TOKEN
    _resetCloudflareDnsConfigForTest()
    expect(getCloudflareDnsConfig()).toBeNull()
  })

  test('caches null too — once disabled, stays disabled until reset', () => {
    // No env set → null.
    expect(getCloudflareDnsConfig()).toBeNull()
    // Set env directly (NOT via setEnv — that helper resets the cache).
    process.env.CF_API_TOKEN = 'cf-token'
    process.env.CF_ZONE_ID = 'zone-abc'
    process.env.KOURIER_LB_IP = '10.0.0.1'
    expect(getCloudflareDnsConfig()).toBeNull() // cache still says null
    _resetCloudflareDnsConfigForTest()
    expect(getCloudflareDnsConfig()).not.toBeNull()
  })
})

// ─── upsertPreviewDnsRecord ───────────────────────────────────────────────

describe('upsertPreviewDnsRecord', () => {
  test('no-op when config is disabled (missing env)', async () => {
    // No env set → no config → must not even touch fetch.
    const fetchSpy = spyOn(globalThis, 'fetch')
    await upsertPreviewDnsRecord('preview--p1.shogo.ai')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test('creates a new proxied A record when none exists', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch((call) => {
      if (call.method === 'GET') return { result: [] }
      return { result: { id: 'new-rec' } }
    })
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await upsertPreviewDnsRecord('preview--p1.shogo.ai')

    expect(calls).toHaveLength(2)

    // List call
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain('/zones/zone-abc/dns_records')
    expect(calls[0].url).toContain('type=A')
    expect(calls[0].url).toContain(encodeURIComponent('preview--p1.shogo.ai'))
    expect(calls[0].headers.Authorization).toBe('Bearer cf-token')
    expect(calls[0].headers['Content-Type']).toBe('application/json')

    // Create call
    expect(calls[1].method).toBe('POST')
    expect(calls[1].url).toBe('https://api.cloudflare.com/client/v4/zones/zone-abc/dns_records')
    expect(calls[1].body).toEqual({
      type: 'A',
      name: 'preview--p1.shogo.ai',
      content: '10.0.0.1',
      proxied: true,
      ttl: 1,
      comment: 'shogo-preview (managed by api)',
    })
  })

  test('uses the configured comment when set', async () => {
    setEnv({ CF_DNS_COMMENT: 'staging' })
    const { fetchImpl, calls } = makeFakeFetch(() => ({ result: [] }))
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await upsertPreviewDnsRecord('preview--p1.shogo.ai')
    expect(calls[1].body.comment).toBe('staging')
  })

  test('idempotent: existing record already correct (same content + proxied) → no write', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch(() => ({
      result: [
        {
          id: 'rec-1',
          name: 'preview--p1.shogo.ai',
          type: 'A',
          content: '10.0.0.1', // matches cfg.lbIp
          proxied: true,
        },
      ],
    }))
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await upsertPreviewDnsRecord('preview--p1.shogo.ai')

    expect(calls).toHaveLength(1) // list-only
    expect(calls[0].method).toBe('GET')
  })

  test('PATCHes when the existing record points to a different IP', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch((call) => {
      if (call.method === 'GET') {
        return {
          result: [
            {
              id: 'rec-1',
              name: 'preview--p1.shogo.ai',
              type: 'A',
              content: '9.9.9.9', // stale
              proxied: true,
            },
          ],
        }
      }
      return { result: { id: 'rec-1' } }
    })
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await upsertPreviewDnsRecord('preview--p1.shogo.ai')

    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].url).toContain('/dns_records/rec-1')
    expect(calls[1].body).toEqual({ content: '10.0.0.1', proxied: true })
  })

  test('PATCHes when the existing record has proxied=false (wrong flag)', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch((call) => {
      if (call.method === 'GET') {
        return {
          result: [
            {
              id: 'rec-1',
              name: 'preview--p1.shogo.ai',
              type: 'A',
              content: '10.0.0.1', // matches IP...
              proxied: false, // ...but proxy flag wrong
            },
          ],
        }
      }
      return { result: { id: 'rec-1' } }
    })
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await upsertPreviewDnsRecord('preview--p1.shogo.ai')
    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].body).toEqual({ content: '10.0.0.1', proxied: true })
  })

  test('non-fatal: list-records 4xx error is logged + swallowed (no throw)', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { fetchImpl, calls } = makeFakeFetch(() => ({
        ok: false,
        errors: [{ code: 9109, message: 'Invalid token' }],
      }))
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = fetchImpl

      await expect(upsertPreviewDnsRecord('preview--p1.shogo.ai')).resolves.toBeUndefined()
      expect(calls).toHaveLength(1)
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('[cloudflare-dns] upsert preview--p1.shogo.ai failed')
      expect(joined).toContain('Cloudflare list-records failed')
      expect(joined).toContain('9109 Invalid token')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('non-fatal: create error is logged + swallowed', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { fetchImpl } = makeFakeFetch((call) => {
        if (call.method === 'GET') return { result: [] }
        return { ok: false, errors: [{ code: 81057, message: 'Record already exists' }] }
      })
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = fetchImpl

      await expect(upsertPreviewDnsRecord('preview--p2.shogo.ai')).resolves.toBeUndefined()
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('81057 Record already exists')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('non-fatal: patch error is logged + swallowed', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { fetchImpl } = makeFakeFetch((call) => {
        if (call.method === 'GET') {
          return {
            result: [
              { id: 'rec-1', name: 'h', type: 'A', content: '9.9.9.9', proxied: true },
            ],
          }
        }
        return { ok: false, errors: [{ code: 81000, message: 'patch denied' }] }
      })
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = fetchImpl

      await expect(upsertPreviewDnsRecord('preview--p3.shogo.ai')).resolves.toBeUndefined()
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('81000 patch denied')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('non-fatal: thrown network error during fetch is caught + logged', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrower = mock(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof globalThis.fetch
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = thrower

      await expect(upsertPreviewDnsRecord('preview--p4.shogo.ai')).resolves.toBeUndefined()
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('ECONNREFUSED')
      expect(joined).toContain('preview--p4.shogo.ai')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('URL-encodes the hostname in the list query', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch(() => ({ result: [] }))
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await upsertPreviewDnsRecord('weird host.shogo.ai')
    expect(calls[0].url).toContain(encodeURIComponent('weird host.shogo.ai'))
  })
})

// ─── deletePreviewDnsRecord ───────────────────────────────────────────────

describe('deletePreviewDnsRecord', () => {
  test('no-op when config is disabled', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
    await deletePreviewDnsRecord('preview--p1.shogo.ai')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test('no-op when the record does not exist (no DELETE issued)', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch(() => ({ result: [] }))
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await deletePreviewDnsRecord('preview--p1.shogo.ai')
    expect(calls).toHaveLength(1) // list only
    expect(calls[0].method).toBe('GET')
  })

  test('issues DELETE with the resolved record id', async () => {
    setEnv()
    const { fetchImpl, calls } = makeFakeFetch((call) => {
      if (call.method === 'GET') {
        return {
          result: [
            {
              id: 'rec-42',
              name: 'preview--p1.shogo.ai',
              type: 'A',
              content: '10.0.0.1',
              proxied: true,
            },
          ],
        }
      }
      return { result: { id: 'rec-42' } }
    })
    const cfg = getCloudflareDnsConfig()!
    cfg.fetch = fetchImpl

    await deletePreviewDnsRecord('preview--p1.shogo.ai')

    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe('DELETE')
    expect(calls[1].url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-abc/dns_records/rec-42',
    )
    expect(calls[1].headers.Authorization).toBe('Bearer cf-token')
  })

  test('non-fatal: list-records failure is logged + swallowed', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { fetchImpl } = makeFakeFetch(() => ({
        ok: false,
        errors: [{ code: 7003, message: 'No such zone' }],
      }))
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = fetchImpl

      await expect(deletePreviewDnsRecord('h.shogo.ai')).resolves.toBeUndefined()
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('[cloudflare-dns] delete h.shogo.ai failed')
      expect(joined).toContain('7003 No such zone')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('non-fatal: DELETE failure is logged + swallowed', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { fetchImpl } = makeFakeFetch((call) => {
        if (call.method === 'GET') {
          return {
            result: [
              { id: 'rec-1', name: 'h', type: 'A', content: '1.1.1.1', proxied: true },
            ],
          }
        }
        return { ok: false, errors: [{ code: 81044, message: 'Record locked' }] }
      })
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = fetchImpl

      await expect(deletePreviewDnsRecord('h.shogo.ai')).resolves.toBeUndefined()
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('81044 Record locked')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('non-fatal: thrown network error is caught + logged', async () => {
    setEnv()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrower = mock(async () => {
        throw new Error('socket hang up')
      }) as unknown as typeof globalThis.fetch
      const cfg = getCloudflareDnsConfig()!
      cfg.fetch = thrower

      await expect(deletePreviewDnsRecord('preview--zz.shogo.ai')).resolves.toBeUndefined()
      const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(joined).toContain('socket hang up')
      expect(joined).toContain('preview--zz.shogo.ai')
    } finally {
      errSpy.mockRestore()
    }
  })
})
