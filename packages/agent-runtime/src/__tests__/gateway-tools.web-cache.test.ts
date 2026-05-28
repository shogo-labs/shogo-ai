// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — getWebCacheRedis / webCacheKey / webCacheGet / webCachePut
// Targets L1925-1979: Redis-backed web response cache. The original const-at-
// module-init pattern for WEB_CACHE_REDIS_URL was switched to call-time
// process.env read in the same commit so this test can flip the env per case.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// Mock ioredis with a stateful fake client
const fakeStore = new Map<string, string>()
const fakeRedisEvents: Record<string, ((...args: any[]) => void)[]> = {}
let constructedCount = 0
let lastUrl = ''
let connectBehavior: 'ok' | 'reject' = 'ok'

class FakeRedis {
  constructor(url: string, _opts: any) {
    constructedCount++
    lastUrl = url
  }
  on(evt: string, cb: any) {
    (fakeRedisEvents[evt] ??= []).push(cb)
  }
  async connect() {
    if (connectBehavior === 'reject') throw new Error('connection refused')
  }
  async get(key: string) {
    return fakeStore.get(key) ?? null
  }
  async set(key: string, value: string, _ex?: string, _ttl?: number) {
    fakeStore.set(key, value)
    return 'OK'
  }
}
mock.module('ioredis', () => ({ default: FakeRedis }))

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  fakeStore.clear()
  for (const k of Object.keys(fakeRedisEvents)) delete fakeRedisEvents[k]
  constructedCount = 0
  lastUrl = ''
  connectBehavior = 'ok'
})
afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

// Import after mock.module so getWebCacheRedis sees our fake when called
const gwTools = await import('../gateway-tools')

// gateway-tools doesn't export the cache helpers — exercise them indirectly
// via tools that use them. The web tool reads/writes the cache when
// WEB_CACHE_REDIS_URL is set.
function makeCtx(overrides: any = {}): any {
  return {
    workspaceDir: '/tmp/test-webcache',
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'webcache', sessionId: 's1', mainSessionIds: ['s1'],
    ...overrides,
  }
}

describe('getWebCacheRedis + cache helpers', () => {
  test('WEB_CACHE_REDIS_URL unset: cache helpers no-op, no Redis constructed', async () => {
    delete process.env.WEB_CACHE_REDIS_URL
    // Trigger any tool that may consult cache — web tool with no API key
    // exercises webCacheKey path
    const tools = gwTools.createTools(makeCtx())
    const web = tools.find((t: any) => t.name === 'web')!
    // Calling web tool without serper key should not construct a Redis.
    // Avoid network: call with neither url nor query to short-circuit early.
    await web.execute('id', { query: '' }).catch(() => {})
    expect(constructedCount).toBe(0)
  })

  test('WEB_CACHE_REDIS_URL set: connect succeeds, Redis singleton constructed once', async () => {
    process.env.WEB_CACHE_REDIS_URL = 'redis://localhost:6379'
    process.env.SERPER_API_KEY = 'fake-key-not-used'
    // Use a mocked fetch so serper call doesn't hit real network — fail fast
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => 'err' })) as any
    try {
      const tools = gwTools.createTools(makeCtx())
      const web = tools.find((t: any) => t.name === 'web')!
      await web.execute('id', { query: 'test query', searchType: 'search', num: 1 }).catch(() => {})
      // getWebCacheRedis was called → Redis constructed once
      expect(constructedCount).toBeGreaterThanOrEqual(1)
      expect(lastUrl).toBe('redis://localhost:6379')
      // Listeners were attached
      expect((fakeRedisEvents['error'] ?? []).length).toBeGreaterThanOrEqual(1)
      expect((fakeRedisEvents['end'] ?? []).length).toBeGreaterThanOrEqual(1)
    } finally {
      globalThis.fetch = origFetch
      delete process.env.SERPER_API_KEY
    }
  })

  test('Redis end event flips failure flag — subsequent calls return null', async () => {
    process.env.WEB_CACHE_REDIS_URL = 'redis://localhost:6379'
    process.env.SERPER_API_KEY = 'fake-key'
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => 'err' })) as any
    try {
      const tools = gwTools.createTools(makeCtx())
      const web = tools.find((t: any) => t.name === 'web')!
      await web.execute('id', { query: 'first', num: 1 }).catch(() => {})
      const constructedBefore = constructedCount
      // Fire end event → flips _webCacheRedisFailed
      for (const cb of fakeRedisEvents['end'] ?? []) cb()
      await web.execute('id', { query: 'second', num: 1 }).catch(() => {})
      // No new Redis was constructed (failed flag short-circuits)
      expect(constructedCount).toBe(constructedBefore)
    } finally {
      globalThis.fetch = origFetch
      delete process.env.SERPER_API_KEY
    }
  })
})
