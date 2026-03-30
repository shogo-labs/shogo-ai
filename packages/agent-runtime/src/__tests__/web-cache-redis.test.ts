// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the Redis-backed web response cache.
 *
 * Requires:
 *   - Redis running on localhost:6379 (docker compose up -d redis)
 *   - SERPER_API_KEY set for search cache tests (optional)
 *
 * Run:
 *   bun test src/__tests__/web-cache-redis.test.ts
 */
import { describe, test, expect, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import Redis from 'ioredis'

const REDIS_URL = 'redis://localhost:6379'
const TEST_DIR = '/tmp/test-web-cache-redis'

// Probe Redis synchronously via a short-lived connection before registering tests
let redisAvailable = false
try {
  const probe = new Redis(REDIS_URL, { connectTimeout: 2000, maxRetriesPerRequest: 0, lazyConnect: false })
  await probe.ping()
  redisAvailable = true
  probe.disconnect()
} catch {
  console.warn('⚠ Redis not reachable at localhost:6379 — skipping web cache integration tests')
}

// Set the env var BEFORE importing gateway-tools so the module picks it up
process.env.WEB_CACHE_REDIS_URL = REDIS_URL

const { createTools } = await import('../gateway-tools')
type ToolContext = Parameters<typeof createTools>[0]

let redis: Redis

function createCtx(): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
  }
}

function getWebTool(ctx: ToolContext) {
  const tools = createTools(ctx)
  const tool = tools.find(t => t.name === 'web')
  if (!tool) throw new Error('web tool not found')
  return tool
}

async function callWeb(params: Record<string, any>) {
  const ctx = createCtx()
  const tool = getWebTool(ctx)
  return tool.execute('test-call', params)
}

async function clearCacheKeys(pattern: string) {
  const keys = await redis.keys(pattern)
  if (keys.length) await redis.del(...keys)
}

const describeRedis = redisAvailable ? describe : describe.skip

describeRedis('web cache redis integration', () => {
  beforeEach(() => {
    if (!redis) redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 })
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    if (redis) {
      await clearCacheKeys('web-cache:*')
      redis.disconnect()
    }
  })

  describe('URL fetch caching', () => {
    test('second fetch of same URL returns cached result from Redis', async () => {
      const params = { url: 'https://httpbin.org/json', maxChars: 5000 }
      await clearCacheKeys('web-cache:fetch:*')

      // First call — network
      const t1Start = performance.now()
      const result1 = await callWeb(params)
      const t1Ms = performance.now() - t1Start

      expect(result1.details.error).toBeUndefined()
      expect(result1.details.content).toBeDefined()
      expect(result1.details.status).toBe(200)

      // Verify cache key was written
      const keys = await redis.keys('web-cache:fetch:*')
      expect(keys.length).toBeGreaterThan(0)

      // Verify TTL is ~30 days (2592000s)
      const ttl = await redis.ttl(keys[0])
      expect(ttl).toBeGreaterThan(2592000 - 60)
      expect(ttl).toBeLessThanOrEqual(2592000)

      // Second call — cache hit
      const t2Start = performance.now()
      const result2 = await callWeb(params)
      const t2Ms = performance.now() - t2Start

      expect(result2.details.content).toBe(result1.details.content)
      expect(result2.details.status).toBe(result1.details.status)

      console.log(`  fetch: network=${t1Ms.toFixed(0)}ms  cached=${t2Ms.toFixed(0)}ms`)
      expect(t2Ms).toBeLessThan(t1Ms)
    }, 20000)

    test('different maxChars produces separate cache entries', async () => {
      await clearCacheKeys('web-cache:fetch:*')

      const result1 = await callWeb({ url: 'https://httpbin.org/json', maxChars: 1000 })
      const result2 = await callWeb({ url: 'https://httpbin.org/json', maxChars: 50000 })

      expect(result1.details.error).toBeUndefined()
      expect(result2.details.error).toBeUndefined()

      const keys = await redis.keys('web-cache:fetch:*')
      expect(keys.length).toBeGreaterThanOrEqual(2)
    }, 20000)
  })

  const describeSearch = process.env.SERPER_API_KEY ? describe : describe.skip

  describeSearch('search caching (requires SERPER_API_KEY)', () => {
    test('second search with same query returns cached result', async () => {
      const params = { query: 'integration test bun runtime 2026', num: 3, gl: 'us', hl: 'en' }
      await clearCacheKeys('web-cache:search:*')

      const t1Start = performance.now()
      const result1 = await callWeb(params)
      const t1Ms = performance.now() - t1Start

      expect(result1.details.error).toBeUndefined()
      expect(result1.details.results).toBeDefined()
      expect(result1.details.raw?.organic?.length).toBeGreaterThan(0)

      const keys = await redis.keys('web-cache:search:*')
      expect(keys.length).toBeGreaterThan(0)

      const t2Start = performance.now()
      const result2 = await callWeb(params)
      const t2Ms = performance.now() - t2Start

      expect(result2.details.results).toBe(result1.details.results)

      console.log(`  search: network=${t1Ms.toFixed(0)}ms  cached=${t2Ms.toFixed(0)}ms`)
      expect(t2Ms).toBeLessThan(t1Ms)
    }, 20000)
  })

  describe('cache resilience', () => {
    test('web tool works when cached value is corrupted JSON', async () => {
      // Manually write a cache key with the correct prefix but broken JSON
      const key = 'web-cache:fetch:corrupted-test'
      await redis.set(key, '{not-valid-json!!!', 'EX', 60)

      // A normal fetch should succeed — bad cache keys don't break the tool
      const result = await callWeb({ url: 'https://httpbin.org/json' })
      expect(result.details.error).toBeUndefined()
      expect(result.details.content).toBeDefined()

      await redis.del(key)
    }, 15000)

    test('cached value round-trips as valid JSON with expected shape', async () => {
      await clearCacheKeys('web-cache:fetch:*')
      await callWeb({ url: 'https://httpbin.org/get', maxChars: 5000 })

      const keys = await redis.keys('web-cache:fetch:*')
      expect(keys.length).toBeGreaterThan(0)

      const raw = await redis.get(keys[0])
      expect(raw).toBeDefined()

      const parsed = JSON.parse(raw!)
      expect(parsed).toHaveProperty('details')
      expect(parsed.details).toHaveProperty('content')
      expect(typeof parsed.details.content).toBe('string')
      expect(parsed.details.content.length).toBeGreaterThan(0)
    }, 15000)
  })
})
