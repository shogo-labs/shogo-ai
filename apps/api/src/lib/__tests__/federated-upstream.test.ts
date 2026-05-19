// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `apps/api/src/lib/federated-upstream.ts` — the helper
 * that lets the local-mode API proxy instance traffic through to the
 * cloud upstream it's already signed in to.
 *
 *   bun test apps/api/src/lib/__tests__/federated-upstream.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'

// ─── Prisma mock (only `localConfig.findUnique` is used by this module) ─────

const findUniqueMock = mock(async (_: any): Promise<any> => null)
mock.module('../prisma', () => ({
  prisma: {
    localConfig: { findUnique: findUniqueMock },
  },
}))

mock.module('../cloud-urls', () => ({
  getShogoCloudUrl: () => 'https://cloud.test',
}))

const {
  getUpstreamCredential,
  getUpstreamWorkspaceId,
  isFederatedEnabled,
  getUpstreamOrigin,
  listCloudInstancesForWorkspace,
  lookupCloudInstance,
  invalidateCloudInstance,
  forwardToUpstream,
  copyResponseHeaders,
  onUpstreamRejection,
  _resetUpstreamCredentialCache,
  _resetInstanceCache,
} = await import('../federated-upstream')

// ─── Helpers ────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
const ORIG_API_KEY = process.env.SHOGO_API_KEY
const ORIG_LOCAL_MODE = process.env.SHOGO_LOCAL_MODE

type FetchCall = { url: string; init?: RequestInit }
let fetchCalls: FetchCall[] = []

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
}

function jsonResponse(body: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_API_KEY = 'shogo_sk_test'
  findUniqueMock.mockReset()
  findUniqueMock.mockImplementation(async () => null)
  fetchCalls = []
  _resetUpstreamCredentialCache()
  _resetInstanceCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (ORIG_API_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIG_API_KEY
  if (ORIG_LOCAL_MODE === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = ORIG_LOCAL_MODE
})

// ─── Credential resolution ─────────────────────────────────────────────────

describe('getUpstreamCredential', () => {
  test('reads from process.env first', async () => {
    process.env.SHOGO_API_KEY = 'env-key'
    findUniqueMock.mockImplementation(async () => ({ value: 'db-key' }))
    expect(await getUpstreamCredential()).toBe('env-key')
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  test('falls back to localConfig when env var is empty', async () => {
    delete process.env.SHOGO_API_KEY
    findUniqueMock.mockImplementation(async () => ({ value: 'db-key' }))
    expect(await getUpstreamCredential()).toBe('db-key')
  })

  test('returns null when neither env nor db has a key', async () => {
    delete process.env.SHOGO_API_KEY
    findUniqueMock.mockImplementation(async () => null)
    expect(await getUpstreamCredential()).toBeNull()
  })

  test('handles prisma throwing gracefully', async () => {
    delete process.env.SHOGO_API_KEY
    findUniqueMock.mockImplementation(async () => { throw new Error('db down') })
    expect(await getUpstreamCredential()).toBeNull()
  })
})

// ─── Local mode gating ─────────────────────────────────────────────────────

describe('isFederatedEnabled', () => {
  test('false when SHOGO_LOCAL_MODE is not set', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    expect(await isFederatedEnabled()).toBe(false)
  })

  test('false when local mode is on but no credential', async () => {
    delete process.env.SHOGO_API_KEY
    findUniqueMock.mockImplementation(async () => null)
    expect(await isFederatedEnabled()).toBe(false)
  })

  test('true when both gates pass', async () => {
    expect(await isFederatedEnabled()).toBe(true)
  })
})

describe('getUpstreamOrigin', () => {
  test('returns the host portion of the configured cloud URL', () => {
    expect(getUpstreamOrigin()).toBe('cloud.test')
  })
})

// ─── List + lookup ──────────────────────────────────────────────────────────

describe('getUpstreamWorkspaceId', () => {
  test('reads workspace.id from SHOGO_KEY_INFO json', async () => {
    findUniqueMock.mockImplementation(async ({ where }: any) => {
      if (where.key === 'SHOGO_KEY_INFO') {
        return { value: JSON.stringify({ workspace: { id: 'cloud-ws-1', name: 'Cloud' } }) }
      }
      return null
    })
    expect(await getUpstreamWorkspaceId()).toBe('cloud-ws-1')
  })

  test('returns null when SHOGO_KEY_INFO is missing', async () => {
    findUniqueMock.mockImplementation(async () => null)
    expect(await getUpstreamWorkspaceId()).toBeNull()
  })

  test('returns null when SHOGO_KEY_INFO is malformed JSON', async () => {
    findUniqueMock.mockImplementation(async () => ({ value: 'not-json' }))
    expect(await getUpstreamWorkspaceId()).toBeNull()
  })
})

describe('listCloudInstancesForWorkspace', () => {
  beforeEach(() => {
    // Default: cloud workspace id is set so the federation path runs.
    findUniqueMock.mockImplementation(async ({ where }: any) => {
      if (where.key === 'SHOGO_KEY_INFO') {
        return { value: JSON.stringify({ workspace: { id: 'cloud-ws-1' } }) }
      }
      return null
    })
  })

  test('returns [] without making a fetch when federation is off', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    installFetch(() => { throw new Error('should not be called') })
    expect(await listCloudInstancesForWorkspace('local-ws-7')).toEqual([])
    expect(fetchCalls).toHaveLength(0)
  })

  test('returns [] when no cloud workspace is linked (SHOGO_KEY_INFO missing)', async () => {
    findUniqueMock.mockImplementation(async () => null)
    installFetch(() => { throw new Error('should not be called') })
    expect(await listCloudInstancesForWorkspace('local-ws-7')).toEqual([])
    expect(fetchCalls).toHaveLength(0)
  })

  test('forwards the CLOUD workspaceId from SHOGO_KEY_INFO (not the local one)', async () => {
    installFetch(() => jsonResponse({ instances: [{ id: 'i1', workspaceId: 'cloud-ws-1' }] }))
    const out = await listCloudInstancesForWorkspace('local-ws-7')
    expect(out).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://cloud.test/api/instances?workspaceId=cloud-ws-1')
    const auth = new Headers(fetchCalls[0].init?.headers as any).get('authorization')
    expect(auth).toBe('Bearer shogo_sk_test')
  })

  test('populates the lookup cache for each returned id', async () => {
    installFetch(() => jsonResponse({ instances: [{ id: 'i1', workspaceId: 'cloud-ws-1', name: 'one' }] }))
    await listCloudInstancesForWorkspace('local-ws-7')
    installFetch(() => { throw new Error('cache miss') })
    const cached = await lookupCloudInstance('i1')
    expect(cached?.name).toBe('one')
  })

  test('returns [] when upstream errors (no throw)', async () => {
    installFetch(() => new Response('boom', { status: 500 }))
    expect(await listCloudInstancesForWorkspace('local-ws-7')).toEqual([])
  })
})

describe('lookupCloudInstance', () => {
  test('caches the fetched row for 60s', async () => {
    installFetch(() => jsonResponse({ id: 'i1', workspaceId: 'ws-1', name: 'cached' }))
    const a = await lookupCloudInstance('i1')
    expect(a?.name).toBe('cached')
    installFetch(() => { throw new Error('should hit cache') })
    const b = await lookupCloudInstance('i1')
    expect(b?.name).toBe('cached')
  })

  test('caches null on 404 (negative cache evicted on invalidate)', async () => {
    installFetch(() => new Response('', { status: 404 }))
    expect(await lookupCloudInstance('missing')).toBeNull()
    installFetch(() => jsonResponse({ id: 'missing', workspaceId: 'ws-1' }))
    // Still cached null.
    expect(await lookupCloudInstance('missing')).toBeNull()
    invalidateCloudInstance('missing')
    expect((await lookupCloudInstance('missing'))?.id).toBe('missing')
  })

  test('returns null when federation is off (no fetch)', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    installFetch(() => { throw new Error('should not fetch') })
    expect(await lookupCloudInstance('anything')).toBeNull()
  })
})

// ─── 401 rejection observer ────────────────────────────────────────────────

describe('onUpstreamRejection', () => {
  test('fires when upstream returns 401, unsubscribe stops further calls', async () => {
    const seen: string[] = []
    const unsubscribe = onUpstreamRejection((reason) => seen.push(reason))

    installFetch(() => new Response('', { status: 401 }))
    await lookupCloudInstance('any')
    expect(seen.length).toBeGreaterThan(0)

    unsubscribe()
    seen.length = 0
    _resetInstanceCache()
    await lookupCloudInstance('another')
    expect(seen).toHaveLength(0)
  })
})

// ─── forwardToUpstream ─────────────────────────────────────────────────────

describe('forwardToUpstream', () => {
  function appWith(handler: (c: any) => Promise<Response>) {
    const app = new Hono()
    app.all('*', handler)
    return app
  }

  test('forwards method, path, querystring, allow-listed headers, and body', async () => {
    installFetch(() =>
      jsonResponse({ ok: true }, 200, { 'x-shogo-trace': 'abc' }),
    )

    const app = appWith(async (c) => forwardToUpstream(c))
    const res = await app.request(
      '/api/instances/some-id/proxy?foo=bar',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shogo-custom': 'preserved',
          'cookie': 'should-not-leak',
          'accept': 'application/json',
        },
        body: JSON.stringify({ hello: 'world' }),
      },
    )
    expect(res.status).toBe(200)

    expect(fetchCalls[0].url).toBe(
      'https://cloud.test/api/instances/some-id/proxy?foo=bar',
    )
    const headers = new Headers(fetchCalls[0].init?.headers as any)
    expect(headers.get('authorization')).toBe('Bearer shogo_sk_test')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-shogo-custom')).toBe('preserved')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('host')).toBeNull()

    const sent = await new Response(fetchCalls[0].init?.body as any).text()
    expect(sent).toBe('{"hello":"world"}')
  })

  test('GET requests do not forward a body', async () => {
    installFetch(() => jsonResponse({ ok: true }))
    const app = appWith(async (c) => forwardToUpstream(c))
    await app.request('/api/instances/i1', { method: 'GET' })
    expect(fetchCalls[0].init?.body).toBeUndefined()
  })

  test('pipes the raw response body (streaming-friendly)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-1'))
        controller.enqueue(new TextEncoder().encode('chunk-2'))
        controller.close()
      },
    })
    installFetch(() => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))

    const app = appWith(async (c) => {
      const upstream = await forwardToUpstream(c)
      return new Response(upstream.body, {
        status: upstream.status,
        headers: copyResponseHeaders(upstream),
      })
    })
    const res = await app.request('/api/instances/i1/p/agent/chat', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('chunk-1chunk-2')
  })
})

describe('copyResponseHeaders', () => {
  test('strips hop-by-hop headers but keeps the rest', () => {
    const resp = new Response('', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '12',
        'transfer-encoding': 'chunked',
        'connection': 'keep-alive',
        'x-shogo-trace': 'abc',
      },
    })
    const headers = copyResponseHeaders(resp)
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-shogo-trace']).toBe('abc')
    expect(headers['content-length']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
    expect(headers['connection']).toBeUndefined()
  })
})
