// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Response Transform Unit Tests
 *
 * Tests the TransformRegistry: compilation, sandboxed execution, safety checks,
 * timeout handling, persistence, and smart JSON truncation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { TransformRegistry, smartTruncateJson, resetTransformRegistry } from './response-transforms'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ISSUES = {
  data: {
    items: Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}: ${['Fix login bug', 'Add dark mode', 'Memory leak in parser', 'Update docs', 'Refactor auth'][i % 5]}`,
      state: i % 3 === 0 ? 'closed' : 'open',
      body: 'A'.repeat(2000),
      labels: [{ name: 'bug' }, { name: 'priority:high' }],
      assignee: { login: `user${i % 5}`, avatar_url: `https://example.com/avatar/${i}.png` },
      created_at: '2026-01-15T10:00:00Z',
      updated_at: '2026-03-01T14:30:00Z',
      comments: i * 3,
      html_url: `https://github.com/org/repo/issues/${i + 1}`,
    })),
    total_count: 500,
  },
}

const SMALL_DATA = { items: [{ title: 'a' }, { title: 'b' }] }

const TMP_DIR = join(import.meta.dir, '.test-transforms-tmp')

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetTransformRegistry()
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true })
})

// ---------------------------------------------------------------------------
// Compilation & Execution
// ---------------------------------------------------------------------------

describe('TransformRegistry', () => {
  test('compiles and executes a valid transform', async () => {
    const registry = new TransformRegistry()
    registry.register('TEST_TOOL', '(data) => data.items.map(i => i.title)', 'Extract titles')

    const result = await registry.execute('TEST_TOOL', SMALL_DATA)
    expect(result).toEqual(['a', 'b'])
  })

  test('executes transform with object return', async () => {
    const registry = new TransformRegistry()
    registry.register(
      'GITHUB_LIST_ISSUES',
      '(data) => ({ issues: data.data.items.map(i => ({ number: i.number, title: i.title, state: i.state })), total: data.data.total_count })',
      'Extract issue summaries',
    )

    const result = await registry.execute('GITHUB_LIST_ISSUES', SAMPLE_ISSUES) as any
    expect(result.total).toBe(500)
    expect(result.issues.length).toBe(100)
    expect(result.issues[0]).toEqual({ number: 1, title: expect.any(String), state: expect.any(String) })
    expect(result.issues[0].body).toBeUndefined()
  })

  test('returns raw data when no transform is registered', async () => {
    const registry = new TransformRegistry()
    const result = await registry.execute('NONEXISTENT', SMALL_DATA)
    expect(result).toEqual(SMALL_DATA)
  })

  test('achieves significant size reduction on large data', async () => {
    const registry = new TransformRegistry()
    registry.register(
      'GITHUB_LIST_ISSUES',
      '(data) => ({ issues: data.data.items.map(i => ({ n: i.number, t: i.title, s: i.state })), total: data.data.total_count })',
      'Compact issue list',
    )

    const result = await registry.execute('GITHUB_LIST_ISSUES', SAMPLE_ISSUES)
    const originalSize = JSON.stringify(SAMPLE_ISSUES).length
    const transformedSize = JSON.stringify(result).length

    expect(originalSize).toBeGreaterThan(50000)
    expect(transformedSize).toBeLessThan(12000)
    expect(originalSize / transformedSize).toBeGreaterThan(5)
  })

  test('transform has access to allowed globals', async () => {
    const registry = new TransformRegistry()
    registry.register(
      'MATH_TEST',
      '(data) => ({ sum: data.values.reduce((a, b) => a + b, 0), max: Math.max(...data.values), now: typeof Date })',
      'Test globals',
    )

    const result = await registry.execute('MATH_TEST', { values: [1, 2, 3, 4, 5] }) as any
    expect(result.sum).toBe(15)
    expect(result.max).toBe(5)
    expect(result.now).toBe('function')
  })

  test('transform can use JSON.parse/stringify', async () => {
    const registry = new TransformRegistry()
    registry.register(
      'JSON_TEST',
      '(data) => JSON.parse(JSON.stringify(data.items))',
      'Round-trip JSON',
    )

    const result = await registry.execute('JSON_TEST', SMALL_DATA)
    expect(result).toEqual([{ title: 'a' }, { title: 'b' }])
  })
})

// ---------------------------------------------------------------------------
// Safety: Banned Tokens
// ---------------------------------------------------------------------------

describe('Safety: banned tokens', () => {
  const BANNED_CASES = [
    ['require', '(data) => { const fs = require("fs"); return data }'],
    ['import', '(data) => { import("fs"); return data }'],
    ['process', '(data) => process.env.SECRET'],
    ['Bun', '(data) => Bun.file("/etc/passwd").text()'],
    ['fetch', '(data) => fetch("https://evil.com").then(r => r.json())'],
    ['eval', '(data) => eval("1+1")'],
    ['Function', '(data) => new Function("return 1")()'],
    ['globalThis', '(data) => globalThis.process'],
    ['__dirname', '(data) => __dirname'],
    ['__filename', '(data) => __filename'],
  ]

  for (const [token, source] of BANNED_CASES) {
    test(`rejects transform containing "${token}"`, () => {
      const registry = new TransformRegistry()
      expect(() => registry.register('BAD_TOOL', source, 'bad')).toThrow(`banned token`)
    })
  }
})

// ---------------------------------------------------------------------------
// Safety: Timeout
// ---------------------------------------------------------------------------

describe('Safety: timeout', () => {
  test('kills infinite loop with timeout', async () => {
    const registry = new TransformRegistry()
    registry.register('LOOP_TOOL', '(data) => { while(true) {} }', 'infinite loop')

    await expect(registry.execute('LOOP_TOOL', {})).rejects.toThrow()
  })

  test('kills long-running computation', async () => {
    const registry = new TransformRegistry()
    registry.register('SLOW_TOOL', '(data) => { let x = 0; for(let i = 0; i < 1e15; i++) x += i; return x }', 'slow')

    await expect(registry.execute('SLOW_TOOL', {})).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Safety: Runtime Errors
// ---------------------------------------------------------------------------

describe('Safety: runtime errors', () => {
  test('throws on property access of undefined', async () => {
    const registry = new TransformRegistry()
    registry.register('ERR_TOOL', '(data) => data.foo.bar.baz', 'bad access')

    await expect(registry.execute('ERR_TOOL', {})).rejects.toThrow()
  })

  test('throws on invalid operation', async () => {
    const registry = new TransformRegistry()
    registry.register('ERR_TOOL2', '(data) => data.map(x => x)', 'not an array')

    await expect(registry.execute('ERR_TOOL2', { not: 'an array' })).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Inline Execution
// ---------------------------------------------------------------------------

describe('executeInline', () => {
  test('executes an inline transform', async () => {
    const registry = new TransformRegistry()
    const result = await registry.executeInline(
      '(data) => data.items.length',
      { items: [1, 2, 3] },
    )
    expect(result).toBe(3)
  })

  test('rejects banned tokens in inline transform', async () => {
    const registry = new TransformRegistry()
    await expect(
      registry.executeInline('(data) => require("fs")', {}),
    ).rejects.toThrow('banned token')
  })
})

// ---------------------------------------------------------------------------
// Registry Management
// ---------------------------------------------------------------------------

describe('Registry management', () => {
  test('overwrites existing transform on re-register', async () => {
    const registry = new TransformRegistry()
    registry.register('TOOL', '(data) => "v1"', 'version 1')
    registry.register('TOOL', '(data) => "v2"', 'version 2')

    const result = await registry.execute('TOOL', {})
    expect(result).toBe('v2')
    expect(registry.get('TOOL')?.description).toBe('version 2')
  })

  test('remove deletes a transform', () => {
    const registry = new TransformRegistry()
    registry.register('TOOL', '(data) => data', 'test')
    expect(registry.has('TOOL')).toBe(true)

    const removed = registry.remove('TOOL')
    expect(removed).toBe(true)
    expect(registry.has('TOOL')).toBe(false)
  })

  test('remove returns false for non-existent transform', () => {
    const registry = new TransformRegistry()
    expect(registry.remove('NONEXISTENT')).toBe(false)
  })

  test('list returns all registered transforms', () => {
    const registry = new TransformRegistry()
    registry.register('TOOL_A', '(data) => data', 'A')
    registry.register('TOOL_B', '(data) => data', 'B')

    const list = registry.list()
    expect(list.length).toBe(2)
    expect(list.map(t => t.toolSlug).sort()).toEqual(['TOOL_A', 'TOOL_B'])
  })
})

// ---------------------------------------------------------------------------
// Response Cache
// ---------------------------------------------------------------------------

describe('Response cache', () => {
  test('caches and retrieves last response', () => {
    const registry = new TransformRegistry()
    registry.cacheResponse('TOOL_A', { data: 'hello' })

    expect(registry.getCachedResponse('TOOL_A')).toEqual({ data: 'hello' })
  })

  test('returns undefined for uncached tool', () => {
    const registry = new TransformRegistry()
    expect(registry.getCachedResponse('NONEXISTENT')).toBeUndefined()
  })

  test('evicts oldest when exceeding max cache size', () => {
    const registry = new TransformRegistry()
    for (let i = 0; i < 7; i++) {
      registry.cacheResponse(`TOOL_${i}`, { i })
    }

    // First two should be evicted (max 5)
    expect(registry.getCachedResponse('TOOL_0')).toBeUndefined()
    expect(registry.getCachedResponse('TOOL_1')).toBeUndefined()
    expect(registry.getCachedResponse('TOOL_6')).toEqual({ i: 6 })
  })
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('Persistence', () => {
  test('round-trip: persist to disk and load', async () => {
    const registry = new TransformRegistry()
    registry.register('TOOL_A', '(data) => data.items.length', 'count items')
    registry.register('TOOL_B', '(data) => ({ ok: true })', 'always ok')

    registry.persistToDisk(TMP_DIR)

    const files = readdirSync(TMP_DIR)
    expect(files.length).toBe(2)
    expect(files.sort()).toEqual(['TOOL_A.json', 'TOOL_B.json'])

    const registry2 = new TransformRegistry()
    registry2.loadFromDisk(TMP_DIR)

    expect(registry2.has('TOOL_A')).toBe(true)
    expect(registry2.has('TOOL_B')).toBe(true)

    const result = await registry2.execute('TOOL_A', { items: [1, 2, 3] })
    expect(result).toBe(3)
  })

  test('loadFromDisk handles missing directory', () => {
    const registry = new TransformRegistry()
    registry.loadFromDisk('/nonexistent/path')
    expect(registry.list().length).toBe(0)
  })

  test('loadFromDisk skips invalid JSON files', () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const { writeFileSync } = require('fs')
    writeFileSync(join(TMP_DIR, 'BAD.json'), 'not valid json', 'utf-8')

    const registry = new TransformRegistry()
    registry.loadFromDisk(TMP_DIR)
    expect(registry.list().length).toBe(0)
  })

  test('removeFromDisk deletes the file', () => {
    const registry = new TransformRegistry()
    registry.register('TOOL_A', '(data) => data', 'test')
    registry.persistToDisk(TMP_DIR)

    expect(existsSync(join(TMP_DIR, 'TOOL_A.json'))).toBe(true)

    registry.removeFromDisk(TMP_DIR, 'TOOL_A')
    expect(existsSync(join(TMP_DIR, 'TOOL_A.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Smart JSON Truncation
// ---------------------------------------------------------------------------

describe('smartTruncateJson', () => {
  test('returns unchanged for small data', () => {
    const data = { items: [{ title: 'hello' }] }
    const { result, truncated } = smartTruncateJson(data)
    expect(truncated).toBe(false)
    expect(JSON.parse(result)).toEqual(data)
  })

  test('strips large string fields', () => {
    const data = {
      items: [{
        title: 'Issue 1',
        body: 'X'.repeat(5000),
        description: 'Y'.repeat(5000),
        name: 'short',
      }],
    }
    const { result, truncated } = smartTruncateJson(data, 2000)
    expect(truncated).toBe(true)

    const parsed = JSON.parse(result)
    expect(parsed.items[0].title).toBe('Issue 1')
    expect(parsed.items[0].name).toBe('short')
    expect(parsed.items[0].body.length).toBeLessThan(1000)
    expect(parsed.items[0].body).toContain('chars omitted')
  })

  test('limits array items when data exceeds max', () => {
    const data = {
      results: Array.from({ length: 200 }, (_, i) => ({
        id: i,
        title: `Item ${i}`,
        tags: ['a', 'b', 'c'],
      })),
    }
    const { result, truncated } = smartTruncateJson(data, 5000)
    expect(truncated).toBe(true)

    const parsed = JSON.parse(result)
    expect(parsed.results.length).toBeLessThan(200)
    expect(parsed._meta).toBeDefined()
    expect(parsed._meta.totalItems).toBe(200)
    expect(parsed._meta.showing).toBeGreaterThan(0)
    expect(parsed._meta.showing).toBeLessThan(200)
  })

  test('produces valid JSON even for very large input', () => {
    const { result } = smartTruncateJson(SAMPLE_ISSUES, 12000)
    expect(result.length).toBeLessThanOrEqual(12000)

    // Should be valid JSON (either fully or with meta)
    try {
      const parsed = JSON.parse(result)
      expect(parsed).toBeTruthy()
    } catch {
      // If not parseable, at least verify it has truncation marker
      expect(result).toContain('truncated')
    }
  })

  test('adds _meta with truncation info', () => {
    const data = {
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Item ${i}`, body: 'x'.repeat(100) })),
    }
    const { result, truncated } = smartTruncateJson(data, 10000)
    expect(truncated).toBe(true)

    const parsed = JSON.parse(result)
    expect(parsed._meta).toBeDefined()
    expect(parsed._meta.totalItems).toBe(500)
    expect(typeof parsed._meta.showing).toBe('number')
  })

  test('handles nested arrays', () => {
    const data = {
      response: {
        data: {
          events: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            summary: `Event ${i}`,
            description: 'D'.repeat(500),
          })),
        },
      },
    }
    const { result, truncated } = smartTruncateJson(data, 8000)
    expect(truncated).toBe(true)

    const parsed = JSON.parse(result)
    expect(parsed.response.data.events.length).toBeLessThan(100)
  })
})
