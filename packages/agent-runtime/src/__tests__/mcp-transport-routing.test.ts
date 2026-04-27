// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, afterAll } from 'bun:test'
import {
  chooseMcpHost,
  detectTransport,
  getCloudFetcher,
} from '../lib/mcp-transport-routing'
import {
  shouldRouteThroughCloud,
  getCloudDispatcher,
  _resetCloudDispatcherForTests,
} from '../lib/cloud-fetcher'

describe('chooseMcpHost', () => {
  const instance = { id: 'inst-123', name: 'my-devbox' }

  test('stdio + active instance routes to worker', () => {
    expect(chooseMcpHost({ transport: 'stdio', activeInstance: instance })).toEqual({
      kind: 'worker',
      instanceId: 'inst-123',
    })
  })

  test('stdio + no active instance routes to cloud', () => {
    expect(chooseMcpHost({ transport: 'stdio', activeInstance: null })).toEqual({
      kind: 'cloud',
    })
    expect(chooseMcpHost({ transport: 'stdio' })).toEqual({ kind: 'cloud' })
  })

  test('http/sse always routes to cloud by default', () => {
    expect(chooseMcpHost({ transport: 'http', activeInstance: instance })).toEqual({
      kind: 'cloud',
    })
    expect(chooseMcpHost({ transport: 'sse', activeInstance: instance })).toEqual({
      kind: 'cloud',
    })
  })

  test("pin='cloud' overrides stdio+instance default", () => {
    expect(
      chooseMcpHost({ transport: 'stdio', activeInstance: instance, pin: 'cloud' }),
    ).toEqual({ kind: 'cloud' })
  })

  test("pin='worker' overrides http+instance default", () => {
    expect(
      chooseMcpHost({ transport: 'http', activeInstance: instance, pin: 'worker' }),
    ).toEqual({ kind: 'worker', instanceId: 'inst-123' })
  })

  test("pin='worker' gracefully degrades to cloud when no instance", () => {
    expect(
      chooseMcpHost({ transport: 'http', activeInstance: null, pin: 'worker' }),
    ).toEqual({ kind: 'cloud' })
  })

  test("pin='auto' is identical to default", () => {
    expect(
      chooseMcpHost({ transport: 'stdio', activeInstance: instance, pin: 'auto' }),
    ).toEqual(chooseMcpHost({ transport: 'stdio', activeInstance: instance }))
  })
})

describe('detectTransport', () => {
  test('command → stdio', () => {
    expect(detectTransport({ command: 'npx' })).toBe('stdio')
  })

  test('http url → http', () => {
    expect(detectTransport({ url: 'https://api.linear.app/mcp' })).toBe('http')
    expect(detectTransport({ url: 'http://localhost:9000/mcp' })).toBe('http')
  })

  test('ws/wss url → sse', () => {
    expect(detectTransport({ url: 'wss://events.example.com' })).toBe('sse')
    expect(detectTransport({ url: 'ws://localhost:9000' })).toBe('sse')
  })

  test('neither command nor url throws', () => {
    expect(() => detectTransport({})).toThrow()
  })

  test('empty command falls through to url detection', () => {
    expect(detectTransport({ command: '', url: 'https://x.io' })).toBe('http')
  })
})

describe('getCloudFetcher', () => {
  test('returns a callable fetch-compatible function', () => {
    const f = getCloudFetcher()
    expect(typeof f).toBe('function')
  })
})

describe('shouldRouteThroughCloud', () => {
  test("pin='cloud' always routes cloud", () => {
    expect(shouldRouteThroughCloud('http://localhost:9000', 'cloud')).toBe(true)
    expect(shouldRouteThroughCloud('https://api.linear.app', 'cloud')).toBe(true)
  })

  test("pin='worker' never routes cloud", () => {
    expect(shouldRouteThroughCloud('https://api.linear.app', 'worker')).toBe(false)
  })

  test('auto: public host routes cloud', () => {
    expect(shouldRouteThroughCloud('https://api.linear.app/mcp')).toBe(true)
    expect(shouldRouteThroughCloud('https://mcp.example.com')).toBe(true)
  })

  test('auto: private / local hosts stay on worker', () => {
    expect(shouldRouteThroughCloud('http://localhost:9000')).toBe(false)
    expect(shouldRouteThroughCloud('http://127.0.0.1:9000')).toBe(false)
    expect(shouldRouteThroughCloud('http://dev.local')).toBe(false)
    expect(shouldRouteThroughCloud('https://db.corp')).toBe(false)
    expect(shouldRouteThroughCloud('https://svc.internal')).toBe(false)
  })

  test('auto: RFC 1918 IP ranges stay on worker', () => {
    expect(shouldRouteThroughCloud('http://10.0.0.5')).toBe(false)
    expect(shouldRouteThroughCloud('http://192.168.1.10')).toBe(false)
    expect(shouldRouteThroughCloud('http://172.16.0.1')).toBe(false)
    expect(shouldRouteThroughCloud('http://172.31.255.255')).toBe(false)
  })

  test('auto: addresses just outside 172.16/12 are public', () => {
    expect(shouldRouteThroughCloud('http://172.15.0.1')).toBe(true)
    expect(shouldRouteThroughCloud('http://172.32.0.1')).toBe(true)
  })

  test('auto: malformed URL fails safe (stays on worker)', () => {
    expect(shouldRouteThroughCloud('not a url')).toBe(false)
  })
})

describe('getCloudDispatcher', () => {
  afterAll(() => {
    _resetCloudDispatcherForTests()
  })

  test('returns a singleton', () => {
    _resetCloudDispatcherForTests()
    const a = getCloudDispatcher()
    const b = getCloudDispatcher()
    expect(a).toBe(b)
  })

  test('reset produces a fresh instance', () => {
    const a = getCloudDispatcher()
    _resetCloudDispatcherForTests()
    const b = getCloudDispatcher()
    expect(a).not.toBe(b)
  })
})
