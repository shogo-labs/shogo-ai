// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test'
import {
  _cloudFetchSeamForTests,
  shouldRouteThroughCloud,
  getCloudDispatcher,
  cloudFetch,
  _resetCloudDispatcherForTests,
} from '../cloud-fetcher'

describe('shouldRouteThroughCloud', () => {
  test('pin=cloud always returns true', () => {
    expect(shouldRouteThroughCloud('http://localhost', 'cloud')).toBe(true)
  })
  test('pin=worker always returns false', () => {
    expect(shouldRouteThroughCloud('https://api.linear.app', 'worker')).toBe(false)
  })
  test('auto: private suffixes return false', () => {
    for (const h of ['http://box.local', 'http://svc.internal', 'http://host.corp',
                     'http://x.lan', 'http://y.intranet']) {
      expect(shouldRouteThroughCloud(h)).toBe(false)
    }
  })
  test('auto: exact private hosts return false', () => {
    for (const h of ['http://localhost', 'http://127.0.0.1', 'http://::1', 'http://0.0.0.0']) {
      expect(shouldRouteThroughCloud(h)).toBe(false)
    }
  })
  test('auto: RFC-1918 IPs return false', () => {
    expect(shouldRouteThroughCloud('http://10.0.0.1')).toBe(false)
    expect(shouldRouteThroughCloud('http://192.168.1.1')).toBe(false)
    expect(shouldRouteThroughCloud('http://172.16.0.1')).toBe(false)
    expect(shouldRouteThroughCloud('http://172.31.255.255')).toBe(false)
  })
  test('auto: public host returns true', () => {
    expect(shouldRouteThroughCloud('https://api.linear.app/mcp')).toBe(true)
  })
  test('auto: malformed URL returns false (catch branch)', () => {
    expect(shouldRouteThroughCloud('not-a-url')).toBe(false)
  })
})

describe('getCloudDispatcher', () => {
  afterEach(() => _resetCloudDispatcherForTests())

  test('returns an Agent instance', () => {
    const d = getCloudDispatcher()
    expect(d).toBeTruthy()
  })
  test('returns the same instance on repeated calls (singleton)', () => {
    expect(getCloudDispatcher()).toBe(getCloudDispatcher())
  })
  test('reset clears the cached agent so next call builds a new one', () => {
    const d1 = getCloudDispatcher()
    _resetCloudDispatcherForTests()
    const d2 = getCloudDispatcher()
    expect(d2).not.toBe(d1)
  })

  test('reset handles an agent whose close() returns a Promise (line 134 .catch arm)', async () => {
    // Force the Bun shim's Agent to have a close() that returns a real
    // Promise so the `maybePromise && typeof .catch === 'function'` branch
    // at line 133 evaluates true and line 134 (.catch noop) fires.
    const agent = getCloudDispatcher() as any
    agent.close = () => Promise.resolve()
    _resetCloudDispatcherForTests() // line 134 fires here
    expect(getCloudDispatcher()).toBeTruthy()
  })

  test('reset handles an agent whose close() returns a REJECTING Promise (exercises the noop catch body)', async () => {
    // The `() => { /* noop */ }` arrow on line 134 is itself a separate
    // function in bun's instrumentation. Make close() return a rejected
    // Promise so the .catch callback actually executes at runtime.
    const agent = getCloudDispatcher() as any
    agent.close = () => Promise.reject(new Error('close failed'))
    _resetCloudDispatcherForTests()
    // Give the micro-task queue one tick to run the rejection handler.
    await Promise.resolve()
    expect(getCloudDispatcher()).toBeTruthy()
  })
})

describe('cloudFetch', () => {
  const origFetch = _cloudFetchSeamForTests.fetch
  afterEach(() => {
    _cloudFetchSeamForTests.fetch = origFetch
    _resetCloudDispatcherForTests()
  })

  test('passes through to undiciFetch with the cloud dispatcher attached', async () => {
    // Use the _cloudFetchSeamForTests seam so we don't need a real HTTP
    // server — undici's fetch ignores globalThis.fetch monkey-patching.
    let capturedInit: any
    _cloudFetchSeamForTests.fetch = async (input: any, init?: any) => {
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) as any
    }
    const res = await cloudFetch('https://api.example.com/test', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(capturedInit?.dispatcher).toBeDefined()
    expect(capturedInit?.dispatcher).toBe(getCloudDispatcher())
  })
})
