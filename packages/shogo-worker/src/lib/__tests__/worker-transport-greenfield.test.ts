// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Greenfield coverage for lib/transport.ts — corporate proxy resolution,
 * env injection, CONNECT-based reachability probe, and allowlist derivation.
 * node:http is mocked with a scriptable fake CONNECT request emitter.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { EventEmitter } from 'node:events'

// ── scriptable node:http request mock ─────────────────────────────────────────
type ConnectScript =
  | { kind: 'connect'; statusCode: number }
  | { kind: 'timeout' }
  | { kind: 'error'; code?: string; message?: string }
  | { kind: 'throw'; message: string }
let connectScript: ConnectScript = { kind: 'connect', statusCode: 200 }
let lastRequestOpts: any = null
const _realHttp = require('node:http')

class FakeClientRequest extends EventEmitter {
  destroyed = false
  destroy() { this.destroyed = true }
  end() {
    queueMicrotask(() => {
      if (connectScript.kind === 'connect') {
        this.emit('connect', { statusCode: connectScript.statusCode }, {}, Buffer.from(''))
      } else if (connectScript.kind === 'timeout') {
        this.emit('timeout')
      } else if (connectScript.kind === 'error') {
        const e: NodeJS.ErrnoException = new Error(connectScript.message ?? 'socket error')
        if (connectScript.code) e.code = connectScript.code
        this.emit('error', e)
      }
    })
  }
}
mock.module('node:http', () => ({
  ..._realHttp,
  request: (opts: any) => {
    lastRequestOpts = opts
    if (connectScript.kind === 'throw') throw new Error(connectScript.message)
    return new FakeClientRequest()
  },
}))

import { resolveProxy, applyProxyToEnv, probeProxy, deriveAllowlist } from '../transport'

beforeEach(() => {
  connectScript = { kind: 'connect', statusCode: 200 }
  lastRequestOpts = null
})
afterAll(() => {
  mock.module('node:http', () => _realHttp)
})

// ════════════════════════════════════════════════════════════════════════════
describe('resolveProxy', () => {
  test('flag wins over every env var', () => {
    const r = resolveProxy('proxy.corp:8080', { HTTPS_PROXY: 'http://env:1' })
    expect(r).toEqual({ url: 'http://proxy.corp:8080', source: 'flag' })
  })
  test('already-schemed flag is preserved', () => {
    expect(resolveProxy('https://p.corp:443')?.url).toBe('https://p.corp:443')
  })
  test('env precedence: HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy', () => {
    expect(resolveProxy(undefined, { HTTPS_PROXY: 'a:1', https_proxy: 'b:2' })?.source).toBe('HTTPS_PROXY')
    expect(resolveProxy(undefined, { https_proxy: 'b:2', HTTP_PROXY: 'c:3' })?.source).toBe('https_proxy')
    expect(resolveProxy(undefined, { HTTP_PROXY: 'c:3', http_proxy: 'd:4' })?.source).toBe('HTTP_PROXY')
    expect(resolveProxy(undefined, { http_proxy: 'd:4' })?.source).toBe('http_proxy')
  })
  test('normalizes bare host:port to http://', () => {
    expect(resolveProxy(undefined, { HTTPS_PROXY: 'host:3128' })?.url).toBe('http://host:3128')
  })
  test('whitespace-only and empty values are ignored', () => {
    expect(resolveProxy('   ', { HTTPS_PROXY: '  ', http_proxy: 'real:9' })?.source).toBe('http_proxy')
  })
  test('returns null when nothing is set', () => {
    expect(resolveProxy(undefined, {})).toBeNull()
  })
})

describe('applyProxyToEnv', () => {
  test('returns env unchanged when proxy is null', () => {
    const env = { FOO: 'bar' }
    expect(applyProxyToEnv(env, null)).toBe(env)
  })
  test('injects all four variants when unset', () => {
    const out = applyProxyToEnv({ PATH: '/x' }, { url: 'http://p:8080', source: 'flag' })
    expect(out.HTTPS_PROXY).toBe('http://p:8080')
    expect(out.https_proxy).toBe('http://p:8080')
    expect(out.HTTP_PROXY).toBe('http://p:8080')
    expect(out.http_proxy).toBe('http://p:8080')
    expect(out.PATH).toBe('/x')
  })
  test('does not overwrite pre-existing proxy vars', () => {
    const out = applyProxyToEnv({ HTTPS_PROXY: 'http://keep:1' }, { url: 'http://new:2', source: 'flag' })
    expect(out.HTTPS_PROXY).toBe('http://keep:1')
    expect(out.http_proxy).toBe('http://new:2')
  })
})

describe('probeProxy', () => {
  const proxy = { url: 'http://proxy.corp:3128', source: 'flag' as const }

  test('CONNECT 200 → ok with detail', async () => {
    connectScript = { kind: 'connect', statusCode: 200 }
    const r = await probeProxy(proxy, 'api.shogo.ai')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('200')
    expect(lastRequestOpts.method).toBe('CONNECT')
    expect(lastRequestOpts.path).toBe('api.shogo.ai:443')
  })
  test('407 → not ok, surfaces auth hint with source', async () => {
    connectScript = { kind: 'connect', statusCode: 407 }
    const r = await probeProxy(proxy)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('407')
    expect(r.detail).toContain('flag')
  })
  test('other status → not ok', async () => {
    connectScript = { kind: 'connect', statusCode: 502 }
    const r = await probeProxy(proxy)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('HTTP 502')
  })
  test('timeout → not ok', async () => {
    connectScript = { kind: 'timeout' }
    const r = await probeProxy(proxy, 'api.shogo.ai', 1234)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('1234ms')
  })
  test('socket error with code → not ok with code', async () => {
    connectScript = { kind: 'error', code: 'ECONNREFUSED', message: 'refused' }
    const r = await probeProxy(proxy)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ECONNREFUSED')
  })
  test('https proxy url with no port defaults to 443', async () => {
    connectScript = { kind: 'connect', statusCode: 200 }
    await probeProxy({ url: 'https://secure.proxy', source: 'HTTPS_PROXY' })
    expect(lastRequestOpts.port).toBe(443)
  })
  test('http proxy url with no port defaults to 80', async () => {
    await probeProxy({ url: 'http://plain.proxy', source: 'HTTP_PROXY' })
    expect(lastRequestOpts.port).toBe(80)
  })
  test('synchronous throw (bad URL) is caught', async () => {
    connectScript = { kind: 'throw', message: 'boom' }
    const r = await probeProxy(proxy)
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('boom')
  })
})

describe('deriveAllowlist', () => {
  test('three-label host → control + tunnel + artifacts', () => {
    const list = deriveAllowlist('https://studio.shogo.ai')
    expect(list.map((h) => h.purpose)).toEqual(['control', 'tunnel-direct', 'artifacts'])
    expect(list[0]).toMatchObject({ host: 'studio.shogo.ai', criticality: 'fatal' })
    expect(list[1].host).toBe('api-direct.shogo.ai')
    expect(list[2].host).toBe('artifacts.shogo.ai')
  })
  test('two-label root domain kept as-is', () => {
    const list = deriveAllowlist('https://shogo.ai')
    expect(list[1].host).toBe('api-direct.shogo.ai')
  })
  test('preserves non-https scheme', () => {
    const list = deriveAllowlist('http://eu.shogo.dev:8443')
    expect(list[0].url).toBe('http://eu.shogo.dev:8443')
    expect(list[2].url).toBe('http://artifacts.shogo.dev')
  })
  test('invalid URL → empty list', () => {
    expect(deriveAllowlist('not a url')).toEqual([])
  })
})
