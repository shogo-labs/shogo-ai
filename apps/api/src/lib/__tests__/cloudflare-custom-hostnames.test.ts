// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the Cloudflare for SaaS custom-hostname helper. It must:
 *   - be disabled (config null) until token + publish zone id are set
 *   - register a custom hostname and surface the DNS records to add
 *   - normalise CF status into our active/instructions/errors shape
 *   - read + delete custom hostnames by id
 *   - write/delete the KV hostname map only when account + namespace are set
 *   - never throw from the best-effort delete / KV paths
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  getCustomHostnamesConfig,
  createCustomHostname,
  getCustomHostname,
  findCustomHostnameByName,
  retriggerCustomHostname,
  deleteCustomHostname,
  putHostnameMapping,
  deleteHostnameMapping,
  _resetCustomHostnamesConfigForTest,
} from '../cloudflare-custom-hostnames'

interface FetchCall {
  url: string
  method: string
  body: any
}

function installFakeFetch(
  responder: (url: string, init: RequestInit) => { status?: number; body: any },
) {
  const calls: FetchCall[] = []
  const fake = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method || 'GET').toUpperCase()
    let body: any
    if (init?.body) {
      try { body = JSON.parse(init.body as string) } catch { body = init.body }
    }
    calls.push({ url, method, body })
    const r = responder(url, init ?? {})
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }
  const original = globalThis.fetch
  globalThis.fetch = fake as any
  return { calls, restore: () => { globalThis.fetch = original } }
}

function setEnv(opts: { kv?: boolean } = {}) {
  process.env.CF_API_TOKEN = 'test-token'
  process.env.CF_CUSTOM_DOMAIN_ZONE_ID = 'zone-one'
  process.env.PUBLISH_DOMAIN = 'shogo.one'
  if (opts.kv) {
    process.env.CF_ACCOUNT_ID = 'acct-1'
    process.env.CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID = 'kv-1'
  }
  _resetCustomHostnamesConfigForTest()
}

function clearEnv() {
  delete process.env.CF_API_TOKEN
  delete process.env.CF_CUSTOM_HOSTNAMES_TOKEN
  delete process.env.CF_CUSTOM_DOMAIN_ZONE_ID
  delete process.env.CF_ACCOUNT_ID
  delete process.env.CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID
  delete process.env.CUSTOM_DOMAIN_FALLBACK_ORIGIN
  delete process.env.CF_CUSTOM_HOSTNAME_SSL_METHOD
  _resetCustomHostnamesConfigForTest()
}

const PENDING_RESULT = {
  id: 'ch-1',
  hostname: 'app.acme.com',
  status: 'pending',
  ssl: {
    status: 'pending_validation',
    method: 'http',
    validation_records: [{ txt_name: '_acme.app.acme.com', txt_value: 'tok123' }],
  },
  ownership_verification: { type: 'txt', name: '_cf.app.acme.com', value: 'own456' },
}

describe('custom-hostnames configuration', () => {
  beforeEach(() => clearEnv())
  afterEach(() => clearEnv())

  test('disabled until token + zone id are present', () => {
    expect(getCustomHostnamesConfig()).toBeNull()
    process.env.CF_API_TOKEN = 't'
    _resetCustomHostnamesConfigForTest()
    expect(getCustomHostnamesConfig()).toBeNull()
    process.env.CF_CUSTOM_DOMAIN_ZONE_ID = 'z'
    _resetCustomHostnamesConfigForTest()
    expect(getCustomHostnamesConfig()).not.toBeNull()
  })

  test('defaults fallback origin to cname.<publish_domain>', () => {
    setEnv()
    expect(getCustomHostnamesConfig()?.fallbackOrigin).toBe('cname.shogo.one')
  })

  test('defaults ssl method to txt (robust with the */* worker route)', () => {
    setEnv()
    expect(getCustomHostnamesConfig()?.sslMethod).toBe('txt')
  })

  test('honors explicit fallback origin + ssl method overrides', () => {
    setEnv()
    process.env.CUSTOM_DOMAIN_FALLBACK_ORIGIN = 'edge.shogo.one'
    process.env.CF_CUSTOM_HOSTNAME_SSL_METHOD = 'http'
    _resetCustomHostnamesConfigForTest()
    const cfg = getCustomHostnamesConfig()
    expect(cfg?.fallbackOrigin).toBe('edge.shogo.one')
    expect(cfg?.sslMethod).toBe('http')
  })

  test('create throws when not enabled', async () => {
    await expect(createCustomHostname('app.acme.com')).rejects.toThrow('not enabled')
  })
})

describe('createCustomHostname', () => {
  beforeEach(() => setEnv())
  afterEach(() => clearEnv())

  test('POSTs the hostname and returns the DNS records to add', async () => {
    const fetched = installFakeFetch(() => ({
      body: { success: true, errors: [], result: PENDING_RESULT },
    }))
    try {
      const state = await createCustomHostname('app.acme.com')
      const posts = fetched.calls.filter((c) => c.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].url).toContain('/zones/zone-one/custom_hostnames')
      expect(posts[0].body).toMatchObject({ hostname: 'app.acme.com', ssl: { method: 'txt', type: 'dv' } })

      expect(state.id).toBe('ch-1')
      expect(state.status).toBe('pending')
      expect(state.active).toBe(false)
      // CNAME routing record always present, pointing at the fallback origin.
      const cname = state.instructions.find((i) => i.type === 'CNAME')
      expect(cname).toMatchObject({ name: 'app.acme.com', value: 'cname.shogo.one', purpose: 'routing' })
      // SSL validation + ownership TXT records surfaced.
      const txts = state.instructions.filter((i) => i.type === 'TXT')
      expect(txts.map((t) => t.purpose).sort()).toEqual(['ownership-verification', 'ssl-validation'])
    } finally {
      fetched.restore()
    }
  })

  test('throws a structured error on CF failure', async () => {
    const fetched = installFakeFetch(() => ({
      status: 400,
      body: { success: false, errors: [{ code: 1406, message: 'hostname taken' }], result: null },
    }))
    try {
      await expect(createCustomHostname('app.acme.com')).rejects.toThrow('1406 hostname taken')
    } finally {
      fetched.restore()
    }
  })
})

describe('getCustomHostname / findCustomHostnameByName', () => {
  beforeEach(() => setEnv())
  afterEach(() => clearEnv())

  test('reports active only when hostname AND ssl are active', async () => {
    const fetched = installFakeFetch(() => ({
      body: {
        success: true,
        errors: [],
        result: { id: 'ch-1', hostname: 'app.acme.com', status: 'active', ssl: { status: 'active' } },
      },
    }))
    try {
      const state = await getCustomHostname('ch-1')
      expect(state?.active).toBe(true)
      expect(state?.sslStatus).toBe('active')
      expect(fetched.calls[0].url).toContain('/custom_hostnames/ch-1')
    } finally {
      fetched.restore()
    }
  })

  test('collects validation + verification errors', async () => {
    const fetched = installFakeFetch(() => ({
      body: {
        success: true,
        errors: [],
        result: {
          id: 'ch-1',
          hostname: 'app.acme.com',
          status: 'pending',
          verification_errors: ['CNAME missing'],
          ssl: { status: 'pending_validation', validation_errors: [{ message: 'TXT not found' }] },
        },
      },
    }))
    try {
      const state = await getCustomHostname('ch-1')
      expect(state?.errors).toEqual(['CNAME missing', 'TXT not found'])
    } finally {
      fetched.restore()
    }
  })

  test('findCustomHostnameByName queries by hostname', async () => {
    const fetched = installFakeFetch(() => ({
      body: { success: true, errors: [], result: [PENDING_RESULT] },
    }))
    try {
      const state = await findCustomHostnameByName('app.acme.com')
      expect(state?.id).toBe('ch-1')
      expect(fetched.calls[0].url).toContain('hostname=app.acme.com')
    } finally {
      fetched.restore()
    }
  })

  test('surfaces the issuing CA and per-record validation status', async () => {
    const fetched = installFakeFetch(() => ({
      body: {
        success: true,
        errors: [],
        result: {
          id: 'ch-1',
          hostname: 'app.acme.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            certificate_authority: 'ssl_com',
            validation_records: [
              { txt_name: '_acme.app.acme.com', txt_value: 'tok123', status: 'pending' },
            ],
          },
        },
      },
    }))
    try {
      const state = await getCustomHostname('ch-1')
      expect(state?.certAuthority).toBe('ssl_com')
      expect(state?.validation).toEqual([
        { name: '_acme.app.acme.com', value: 'tok123', status: 'pending' },
      ])
    } finally {
      fetched.restore()
    }
  })
})

describe('retriggerCustomHostname', () => {
  beforeEach(() => setEnv())
  afterEach(() => clearEnv())

  test('PATCHes the SSL config (same DV method) without changing tokens', async () => {
    const fetched = installFakeFetch(() => ({
      body: { success: true, errors: [], result: PENDING_RESULT },
    }))
    try {
      const state = await retriggerCustomHostname('ch-1')
      const patch = fetched.calls.find((c) => c.method === 'PATCH')!
      expect(patch).toBeDefined()
      expect(patch.url).toContain('/zones/zone-one/custom_hostnames/ch-1')
      // Re-trigger only re-submits the SSL block (DV, same method) — no
      // `hostname` key, so Cloudflare keeps the existing validation tokens.
      expect(patch.body).toEqual({
        ssl: {
          method: 'txt',
          type: 'dv',
          settings: { min_tls_version: '1.2' },
          bundle_method: 'ubiquitous',
        },
      })
      expect(state?.id).toBe('ch-1')
    } finally {
      fetched.restore()
    }
  })

  test('throws a structured error on CF failure', async () => {
    const fetched = installFakeFetch(() => ({
      status: 400,
      body: { success: false, errors: [{ code: 1234, message: 'nope' }], result: null },
    }))
    try {
      await expect(retriggerCustomHostname('ch-1')).rejects.toThrow('1234 nope')
    } finally {
      fetched.restore()
    }
  })

  test('returns null (no-op) when the feature is disabled', async () => {
    clearEnv()
    expect(await retriggerCustomHostname('ch-1')).toBeNull()
  })
})

describe('deleteCustomHostname', () => {
  beforeEach(() => setEnv())
  afterEach(() => clearEnv())

  test('DELETEs by id and returns true', async () => {
    const fetched = installFakeFetch(() => ({ body: { success: true, errors: [], result: { id: 'ch-1' } } }))
    try {
      expect(await deleteCustomHostname('ch-1')).toBe(true)
      expect(fetched.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    } finally {
      fetched.restore()
    }
  })

  test('swallows errors and returns false', async () => {
    const fetched = installFakeFetch(() => ({
      status: 500,
      body: { success: false, errors: [{ code: 1, message: 'boom' }], result: null },
    }))
    try {
      expect(await deleteCustomHostname('ch-1')).toBe(false)
    } finally {
      fetched.restore()
    }
  })
})

describe('KV hostname map', () => {
  afterEach(() => clearEnv())

  test('put/delete are no-ops without account + namespace', async () => {
    setEnv() // no kv config
    const fetched = installFakeFetch(() => ({ body: {} }))
    try {
      expect(await putHostnameMapping('app.acme.com', 'myapp')).toBe(false)
      expect(await deleteHostnameMapping('app.acme.com')).toBe(false)
      expect(fetched.calls).toHaveLength(0)
    } finally {
      fetched.restore()
    }
  })

  test('PUT writes JSON {s,c} to the namespaced key (canonical defaults to self)', async () => {
    setEnv({ kv: true })
    const fetched = installFakeFetch(() => ({ body: { success: true } }))
    try {
      expect(await putHostnameMapping('app.acme.com', 'myapp')).toBe(true)
      const put = fetched.calls.find((c) => c.method === 'PUT')!
      expect(put.url).toContain('/accounts/acct-1/storage/kv/namespaces/kv-1/values/app.acme.com')
      // installFakeFetch JSON-parses the body, so it round-trips to an object.
      expect(put.body).toEqual({ s: 'myapp', c: 'app.acme.com' })
    } finally {
      fetched.restore()
    }
  })

  test('PUT carries the canonical hostname for an apex/www redirect', async () => {
    setEnv({ kv: true })
    const fetched = installFakeFetch(() => ({ body: { success: true } }))
    try {
      expect(await putHostnameMapping('acme.com', 'myapp', 'www.acme.com')).toBe(true)
      const put = fetched.calls.find((c) => c.method === 'PUT')!
      expect(put.body).toEqual({ s: 'myapp', c: 'www.acme.com' })
    } finally {
      fetched.restore()
    }
  })

  test('DELETE treats 404 as success', async () => {
    setEnv({ kv: true })
    const fetched = installFakeFetch(() => ({ status: 404, body: { success: false } }))
    try {
      expect(await deleteHostnameMapping('app.acme.com')).toBe(true)
    } finally {
      fetched.restore()
    }
  })
})
