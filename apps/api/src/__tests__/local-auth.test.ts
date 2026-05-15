// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/local-auth.ts — the local-mode cloud session
 * routes (signout / heartbeat / status). These run inside the desktop
 * API process and proxy to the Shogo cloud.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── Mocks ─────────────────────────────────────────────────────────────────

const findUniqueMock = mock(async (_: any): Promise<any> => null)
const deleteManyMock = mock(async (_: any): Promise<any> => ({ count: 0 }))

mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: findUniqueMock,
      deleteMany: deleteManyMock,
    },
  },
}))

mock.module('../lib/cloud-urls', () => ({
  getShogoCloudUrl: () => 'https://cloud.test',
}))

const stopInstanceTunnel = mock(() => {})
mock.module('../lib/instance-tunnel', () => ({
  stopInstanceTunnel,
}))

const { localAuthRoutes } = await import('../routes/local-auth')

// ─── Helpers ───────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch

function mountApp() {
  const app = new Hono()
  app.route('/api', localAuthRoutes())
  return app
}

function mockFetch(handler: (url: string, init?: any) => any) {
  const spy = mock(async (url: string, init?: any) => handler(url, init))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

function bridgeOk(body: any = { ok: true }) {
  return { ok: true, status: 200, json: async () => body }
}

function bridgeErr(status: number, body: any = {}) {
  return { ok: false, status, json: async () => body }
}

// ─── Test lifecycle ────────────────────────────────────────────────────────

const ORIG_API_KEY = process.env.SHOGO_API_KEY

beforeAll(() => {
  // Ensure no real fetch leaks during these tests.
  globalThis.fetch = (async () => {
    throw new Error('fetch was not mocked')
  }) as any
})

afterAll(() => {
  globalThis.fetch = realFetch
  if (ORIG_API_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIG_API_KEY
})

beforeEach(() => {
  findUniqueMock.mockReset()
  findUniqueMock.mockImplementation(async () => null)
  deleteManyMock.mockReset()
  deleteManyMock.mockImplementation(async () => ({ count: 1 }))
  stopInstanceTunnel.mockReset()
  stopInstanceTunnel.mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = (async () => {
    throw new Error('fetch was not mocked')
  }) as any
})

// ─── POST /local/cloud-login/signout ───────────────────────────────────────

describe('POST /local/cloud-login/signout', () => {
  test('deletes both localConfig keys, clears env var, and returns ok:true', async () => {
    process.env.SHOGO_API_KEY = 'sk_to_clear'
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/signout', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deleteManyMock).toHaveBeenCalledTimes(2)
    const keys = deleteManyMock.mock.calls.map((c) => c[0].where.key).sort()
    expect(keys).toEqual(['SHOGO_API_KEY', 'SHOGO_KEY_INFO'])
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
  })

  test('still returns ok:true if instance-tunnel stop throws (best-effort cleanup)', async () => {
    stopInstanceTunnel.mockImplementation(() => {
      throw new Error('tunnel stop crashed')
    })
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/signout', { method: 'POST' })
    // Signout swallows the tunnel error inside a .catch() chain — never
    // surfaces it to the caller.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('signout after a prior 401 rejection resets the cloudKeyRejected flag', async () => {
    // First trigger a 401 via heartbeat to set cloudKeyRejected = true.
    findUniqueMock.mockImplementation(async () => ({ value: 'sk_revoked' }))
    mockFetch(() => bridgeErr(401, { ok: false, error: 'revoked' }))
    const app = mountApp()
    const hb = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(hb.status).toBe(401)
    expect((await hb.json()).cloudKeyRejected).toBe(true)

    // Now signout. cloudKeyRejected should be cleared (we observe via status).
    await app.request('/api/local/cloud-login/signout', { method: 'POST' })

    findUniqueMock.mockImplementation(async () => ({ value: 'sk_new' }))
    const statusRes = await app.request('/api/local/cloud-login/status')
    const statusBody = await statusRes.json()
    expect(statusBody.cloudKeyRejected).toBe(false)
  })
})

// ─── POST /local/cloud-login/heartbeat ─────────────────────────────────────

describe('POST /local/cloud-login/heartbeat', () => {
  test('returns 401 when no SHOGO_API_KEY is stored', async () => {
    findUniqueMock.mockImplementation(async () => null)
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Not signed in' })
  })

  test('returns 401 when the row exists but value is empty', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: '' }))
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('hits the cloud heartbeat endpoint with the stored key', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk_stored' }))
    const spy = mockFetch((url, init) => {
      expect(url).toBe('https://cloud.test/api/api-keys/heartbeat')
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('application/json')
      const body = JSON.parse(init.body)
      expect(body.key).toBe('sk_stored')
      return bridgeOk({ ok: true })
    })

    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceAppVersion: '1.2.3' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('forwards deviceAppVersion when provided in the body', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk_stored' }))
    const spy = mockFetch(() => bridgeOk())
    const app = mountApp()
    await app.request('/api/local/cloud-login/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceAppVersion: '9.9.9-beta' }),
    })
    const body = JSON.parse(spy.mock.calls[0][1].body)
    expect(body.deviceAppVersion).toBe('9.9.9-beta')
  })

  test('tolerates missing/invalid JSON body (deviceAppVersion undefined)', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk_stored' }))
    const spy = mockFetch(() => bridgeOk())
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(spy.mock.calls[0][1].body)
    expect(body.deviceAppVersion).toBeUndefined()
    expect(body.key).toBe('sk_stored')
  })

  test('401 from cloud sets cloudKeyRejected=true and propagates the status', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk_revoked' }))
    mockFetch(() => bridgeErr(401, { ok: false, error: 'key revoked' }))
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.cloudKeyRejected).toBe(true)
    expect(body.error).toBe('key revoked')
  })

  test('falls back to HTTP <status> when cloud body has no error field', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk' }))
    mockFetch(() => bridgeErr(503, {}))
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('HTTP 503')
    expect(body.cloudKeyRejected).toBe(false) // only true on 401
  })

  test('treats {ok:false} response from cloud as failure', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk' }))
    mockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'soft fail' }) }))
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(res.status).toBe(200) // res.status was 200 so we return 200
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('soft fail')
  })

  test('returns 502 on fetch network error with the err.message', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk' }))
    mockFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('ECONNREFUSED')
  })

  test('clears cloudKeyRejected when a subsequent heartbeat succeeds', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'sk' }))
    // First, set the flag via a 401.
    mockFetch(() => bridgeErr(401, { ok: false }))
    const app = mountApp()
    await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })

    // Then a successful heartbeat clears it.
    mockFetch(() => bridgeOk({ ok: true }))
    await app.request('/api/local/cloud-login/heartbeat', { method: 'POST' })

    const statusRes = await app.request('/api/local/cloud-login/status')
    expect((await statusRes.json()).cloudKeyRejected).toBe(false)
  })
})

// ─── GET /local/cloud-login/status ─────────────────────────────────────────

describe('GET /local/cloud-login/status', () => {
  test('returns signedIn:false when no key is stored', async () => {
    findUniqueMock.mockImplementation(async () => null)
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.signedIn).toBe(false)
    expect(body.cloudUrl).toBe('https://cloud.test')
  })

  test('returns signedIn:true with workspace/email/deviceId from SHOGO_KEY_INFO', async () => {
    findUniqueMock.mockImplementation(async (args: any) => {
      if (args.where.key === 'SHOGO_API_KEY') return { value: 'shogo_sk_1234567890abcdef_more' }
      if (args.where.key === 'SHOGO_KEY_INFO')
        return {
          value: JSON.stringify({
            email: 'u@test.com',
            workspace: { id: 'ws_1', name: 'Test WS', slug: 'test-ws' },
            deviceId: 'dev_1',
          }),
        }
      return null
    })

    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/status')
    const body = await res.json()
    expect(body.signedIn).toBe(true)
    expect(body.cloudUrl).toBe('https://cloud.test')
    expect(body.email).toBe('u@test.com')
    expect(body.workspace).toEqual({ id: 'ws_1', name: 'Test WS', slug: 'test-ws' })
    expect(body.deviceId).toBe('dev_1')
    expect(body.keyPrefix).toBe('shogo_sk_1234567')
    expect(body.keyPrefix.length).toBe(16)
  })

  test('handles unparseable SHOGO_KEY_INFO gracefully (null email/workspace/deviceId)', async () => {
    findUniqueMock.mockImplementation(async (args: any) => {
      if (args.where.key === 'SHOGO_API_KEY') return { value: 'sk_short' }
      if (args.where.key === 'SHOGO_KEY_INFO') return { value: '{not valid json' }
      return null
    })
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/status')
    const body = await res.json()
    expect(body.signedIn).toBe(true)
    expect(body.email).toBeNull()
    expect(body.workspace).toBeNull()
    expect(body.deviceId).toBeNull()
  })

  test('handles missing SHOGO_KEY_INFO row (only SHOGO_API_KEY set)', async () => {
    findUniqueMock.mockImplementation(async (args: any) => {
      if (args.where.key === 'SHOGO_API_KEY') return { value: 'sk_only' }
      return null
    })
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/status')
    const body = await res.json()
    expect(body.signedIn).toBe(true)
    expect(body.email).toBeNull()
    expect(body.workspace).toBeNull()
    expect(body.deviceId).toBeNull()
  })

  test('keyPrefix is exactly the first 16 chars of the stored key', async () => {
    findUniqueMock.mockImplementation(async (args: any) => {
      if (args.where.key === 'SHOGO_API_KEY')
        return { value: 'shogo_sk_aaaaaaaaaaaaaaaa_morechars' }
      return null
    })
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/status')
    const body = await res.json()
    expect(body.keyPrefix).toBe('shogo_sk_aaaaaaa')
  })

  test('falls back to null when the prisma findUnique itself throws', async () => {
    findUniqueMock.mockImplementation(async () => {
      throw new Error('db down')
    })
    const app = mountApp()
    const res = await app.request('/api/local/cloud-login/status')
    // readStoredKey has .catch(() => null) — db failure is transparent.
    const body = await res.json()
    expect(body.signedIn).toBe(false)
  })
})
