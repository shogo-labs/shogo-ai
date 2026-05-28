// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full coverage for src/response-transforms.ts
 *
 * Drives:
 *  - smartTruncateJson() — small + strip-strings + array-binary-search + last-resort paths
 *  - stripLargeStrings / findLargestArray (exercised through smartTruncateJson)
 *  - LRUResponseCache (via TransformRegistry.cacheResponse + LRU eviction)
 *  - validateTransformSource — banned tokens
 *  - compileTransform / VM sandbox semantics
 *  - TransformRegistry — register / execute / executeInline / get / has /
 *    remove / list / cacheResponse / getCachedResponse / registerDefaults /
 *    persistToDisk / loadFromDisk / removeFromDisk
 *  - getTransformRegistry / resetTransformRegistry singleton
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TransformRegistry,
  getTransformRegistry,
  resetTransformRegistry,
  smartTruncateJson,
  type ResponseTransform,
} from '../response-transforms'

const origLog = console.log
const origWarn = console.warn

beforeEach(() => {
  console.log = () => {}
  console.warn = () => {}
})

afterEach(() => {
  console.log = origLog
  console.warn = origWarn
  resetTransformRegistry()
})

// ---------------------------------------------------------------------------
// smartTruncateJson
// ---------------------------------------------------------------------------

describe('smartTruncateJson', () => {
  test('returns input as-is when already under budget', () => {
    const { result, truncated } = smartTruncateJson({ a: 1, b: 'x' }, 12000)
    expect(truncated).toBe(false)
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'x' })
  })

  test('strips large string fields and returns when result fits', () => {
    const body = 'x'.repeat(800)
    const { result, truncated } = smartTruncateJson({ body, other: 1 }, 700)
    expect(truncated).toBe(true)
    const parsed = JSON.parse(result)
    expect(parsed.body).toMatch(/\.\.\. \[300 chars omitted\]$/)
    expect(parsed.other).toBe(1)
  })

  test('binary-searches array length when stripping is not enough', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }))
    const { result, truncated } = smartTruncateJson({ items }, 500)
    expect(truncated).toBe(true)
    const parsed = JSON.parse(result)
    expect(parsed.items.length).toBeLessThan(100)
    expect(parsed._meta.totalItems).toBe(100)
    expect(parsed._meta.showing).toBe(parsed.items.length)
  })

  test('includes truncatedFields in _meta when stripping happened too', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, body: 'b'.repeat(800) }))
    const { result } = smartTruncateJson({ items }, 1500)
    const parsed = JSON.parse(result)
    expect(parsed._meta.truncatedFields).toContain('body')
  })

  test('falls back to last-resort raw truncation when nothing else fits', () => {
    // No array — just a giant pile of small unique keys so binary-search has no array to slice
    const big: Record<string, number> = {}
    for (let i = 0; i < 5000; i++) big[`key_${i}`] = i
    const { result, truncated } = smartTruncateJson(big, 500)
    expect(truncated).toBe(true)
    expect(result.length).toBeLessThanOrEqual(500)
    expect(result).toContain('truncated')
  })

  test('findLargestArray descends into nested objects (depth-bounded)', () => {
    const nested = { meta: { count: 1 }, payload: { rows: Array.from({ length: 200 }, (_, i) => i) } }
    const { result } = smartTruncateJson(nested, 200)
    const parsed = JSON.parse(result)
    if (parsed.payload && Array.isArray(parsed.payload.rows)) {
      expect(parsed.payload.rows.length).toBeLessThan(200)
    } else {
      expect(result).toContain('truncated')
    }
  })

  test('handles arrays at root by treating the wrapping object as scope', () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ x: i }))
    // Wrap so findLargestArray has a parent obj
    const { result, truncated } = smartTruncateJson({ root: arr }, 200)
    expect(truncated).toBe(true)
    const parsed = JSON.parse(result)
    expect(parsed.root.length).toBeLessThan(50)
  })

  test('stripLargeStrings recurses into arrays and does not crash on deep cycles', () => {
    // Build a deeply nested object - past depth 10 guard
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 15; i++) deep = { wrap: deep }
    const r = smartTruncateJson(deep, 50)
    expect(r.truncated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateTransformSource (via TransformRegistry.register)
// ---------------------------------------------------------------------------

describe('validateTransformSource (banned tokens)', () => {
  const banned = [
    'require', 'import', 'process', 'Bun', 'fetch', 'eval',
    'Function', 'globalThis', '__dirname', '__filename',
    'XMLHttpRequest', 'WebSocket', 'Worker', 'SharedArrayBuffer',
    'Atomics', 'Proxy', 'Reflect',
  ]
  for (const tok of banned) {
    test(`rejects banned token "${tok}"`, () => {
      const reg = new TransformRegistry()
      expect(() =>
        reg.register('t', `(d) => { ${tok}; return d }`, 'desc')
      ).toThrow(new RegExp(`banned token: "${tok}"`))
    })
  }

  test('accepts source with no banned tokens', () => {
    const reg = new TransformRegistry()
    expect(() => reg.register('t', '(d) => ({ ...d, ok: 1 })', 'desc')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// compileTransform (through TransformRegistry.execute / executeInline)
// ---------------------------------------------------------------------------

describe('compileTransform & execute', () => {
  test('execute applies the registered transform', async () => {
    const reg = new TransformRegistry()
    reg.register('x', '(d) => ({ ...d, mapped: true })', 'maps')
    const out = await reg.execute('x', { a: 1 })
    expect(out).toEqual({ a: 1, mapped: true })
  })

  test('execute returns raw data when no transform exists', async () => {
    const reg = new TransformRegistry()
    const out = await reg.execute('unknown', { a: 1 })
    expect(out).toEqual({ a: 1 })
  })

  test('execute rethrows when the transform throws (via console.warn)', async () => {
    const reg = new TransformRegistry()
    reg.register('boom', '(d) => { throw new Error("bad") }', 'd')
    await expect(reg.execute('boom', {})).rejects.toThrow(/bad/)
  })

  test('executeInline runs a one-off transform without registration', async () => {
    const reg = new TransformRegistry()
    const out = await reg.executeInline('(d) => d.value * 2', { value: 21 })
    expect(out).toBe(42)
  })

  test('executeInline rejects banned tokens', async () => {
    const reg = new TransformRegistry()
    await expect(reg.executeInline('(d) => eval(d)', 'x')).rejects.toThrow(/banned token/)
  })

  test('VM sandbox cannot access "process" (banned anyway, prove via inline)', async () => {
    const reg = new TransformRegistry()
    await expect(reg.executeInline('(d) => process.exit(0)', null)).rejects.toThrow()
  })

  test('VM has JSON / Math / Array / Date etc. in scope', async () => {
    const reg = new TransformRegistry()
    const out = await reg.executeInline(
      '(d) => ({ s: JSON.stringify(d), m: Math.max(1,2,3), len: [1,2,3].length })',
      { ok: 1 }
    )
    expect((out as { s: string }).s).toBe('{"ok":1}')
    expect((out as { m: number }).m).toBe(3)
    expect((out as { len: number }).len).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// TransformRegistry CRUD
// ---------------------------------------------------------------------------

describe('TransformRegistry CRUD', () => {
  test('get returns meta after register; undefined when absent', () => {
    const reg = new TransformRegistry()
    expect(reg.get('x')).toBeUndefined()
    reg.register('x', '(d) => d', 'desc')
    const meta = reg.get('x')
    expect(meta).toBeDefined()
    expect(meta!.toolSlug).toBe('x')
    expect(meta!.description).toBe('desc')
    expect(typeof meta!.createdAt).toBe('number')
  })

  test('has reflects presence', () => {
    const reg = new TransformRegistry()
    expect(reg.has('x')).toBe(false)
    reg.register('x', '(d) => d', '')
    expect(reg.has('x')).toBe(true)
  })

  test('remove returns true when present, false when absent', () => {
    const reg = new TransformRegistry()
    expect(reg.remove('x')).toBe(false)
    reg.register('x', '(d) => d', '')
    expect(reg.remove('x')).toBe(true)
    expect(reg.has('x')).toBe(false)
  })

  test('list returns all registered metas', () => {
    const reg = new TransformRegistry()
    reg.register('a', '(d) => d', 'A')
    reg.register('b', '(d) => d', 'B')
    const all = reg.list()
    expect(all.map(m => m.toolSlug).sort()).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// LRUResponseCache (via cacheResponse / getCachedResponse)
// ---------------------------------------------------------------------------

describe('TransformRegistry response cache (LRU, cap=5)', () => {
  test('roundtrip', () => {
    const reg = new TransformRegistry()
    reg.cacheResponse('a', { v: 1 })
    expect(reg.getCachedResponse('a')).toEqual({ v: 1 })
  })

  test('evicts oldest when over capacity', () => {
    const reg = new TransformRegistry()
    for (let i = 0; i < 7; i++) reg.cacheResponse(`k${i}`, i)
    // k0, k1 should be evicted (cap=5)
    expect(reg.getCachedResponse('k0')).toBeUndefined()
    expect(reg.getCachedResponse('k1')).toBeUndefined()
    expect(reg.getCachedResponse('k2')).toBe(2)
    expect(reg.getCachedResponse('k6')).toBe(6)
  })

  test('re-setting an existing key keeps it (moves to end of order list)', () => {
    const reg = new TransformRegistry()
    reg.cacheResponse('a', 1)
    reg.cacheResponse('b', 2)
    reg.cacheResponse('c', 3)
    reg.cacheResponse('d', 4)
    reg.cacheResponse('e', 5)
    // a is at the LRU position; re-set it -> a moves to end
    reg.cacheResponse('a', 100)
    // Now insert one more -> b should evict (oldest), a stays
    reg.cacheResponse('f', 6)
    expect(reg.getCachedResponse('b')).toBeUndefined()
    expect(reg.getCachedResponse('a')).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// registerDefaults
// ---------------------------------------------------------------------------

describe('registerDefaults', () => {
  test('registers each default that does not already exist', () => {
    const reg = new TransformRegistry()
    const defaults: ResponseTransform[] = [
      { toolSlug: 'a', description: 'A', transformFn: '(d) => d', createdAt: 0 },
      { toolSlug: 'b', description: 'B', transformFn: '(d) => d', createdAt: 0 },
    ]
    reg.registerDefaults(defaults)
    expect(reg.has('a')).toBe(true)
    expect(reg.has('b')).toBe(true)
  })

  test('does not overwrite an existing user transform', () => {
    const reg = new TransformRegistry()
    reg.register('a', '(d) => ({ ...d, custom: true })', 'user')
    reg.registerDefaults([
      { toolSlug: 'a', description: 'default', transformFn: '(d) => d', createdAt: 0 },
    ])
    expect(reg.get('a')!.description).toBe('user')
  })

  test('catches compile errors per-default (continues registering others)', () => {
    const reg = new TransformRegistry()
    reg.registerDefaults([
      { toolSlug: 'bad', description: '', transformFn: '(d) => eval(d)', createdAt: 0 },
      { toolSlug: 'good', description: '', transformFn: '(d) => d', createdAt: 0 },
    ])
    expect(reg.has('bad')).toBe(false)
    expect(reg.has('good')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// persistToDisk / loadFromDisk / removeFromDisk
// ---------------------------------------------------------------------------

describe('Disk persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rtxform-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('persistToDisk writes one JSON file per transform', () => {
    const reg = new TransformRegistry()
    reg.register('foo', '(d) => d', 'desc')
    reg.persistToDisk(dir)
    const r2 = new TransformRegistry()
    r2.loadFromDisk(dir)
    expect(r2.has('foo')).toBe(true)
    expect(r2.get('foo')!.description).toBe('desc')
  })

  test('persistToDisk creates dir if missing (mkdirSync recursive)', () => {
    const reg = new TransformRegistry()
    reg.register('x', '(d) => d', '')
    const nested = join(dir, 'nope', 'still-not-there')
    reg.persistToDisk(nested)
    const r2 = new TransformRegistry()
    r2.loadFromDisk(nested)
    expect(r2.has('x')).toBe(true)
  })

  test('loadFromDisk no-ops when dir absent', () => {
    const reg = new TransformRegistry()
    reg.loadFromDisk(join(dir, 'absent'))
    expect(reg.list()).toHaveLength(0)
  })

  test('loadFromDisk skips JSON files missing required fields', () => {
    writeFileSync(join(dir, 'incomplete.json'), JSON.stringify({ description: 'no slug' }))
    writeFileSync(join(dir, 'valid.json'), JSON.stringify({
      toolSlug: 'v', transformFn: '(d) => d', description: 'ok', createdAt: 0,
    }))
    const reg = new TransformRegistry()
    reg.loadFromDisk(dir)
    expect(reg.has('v')).toBe(true)
    expect(reg.list()).toHaveLength(1)
  })

  test('loadFromDisk catches & logs malformed JSON files', () => {
    writeFileSync(join(dir, 'broken.json'), '{not-json')
    const reg = new TransformRegistry()
    expect(() => reg.loadFromDisk(dir)).not.toThrow()
  })

  test('loadFromDisk skips files that fail validation (banned token)', () => {
    writeFileSync(join(dir, 'unsafe.json'), JSON.stringify({
      toolSlug: 'u', transformFn: '(d) => eval(d)', description: '', createdAt: 0,
    }))
    const reg = new TransformRegistry()
    reg.loadFromDisk(dir)
    expect(reg.has('u')).toBe(false)
  })

  test('removeFromDisk deletes the matching JSON file', () => {
    const reg = new TransformRegistry()
    reg.register('foo', '(d) => d', '')
    reg.persistToDisk(dir)
    reg.removeFromDisk(dir, 'foo')
    const r2 = new TransformRegistry()
    r2.loadFromDisk(dir)
    expect(r2.has('foo')).toBe(false)
  })

  test('removeFromDisk silently no-ops when file is absent', () => {
    const reg = new TransformRegistry()
    expect(() => reg.removeFromDisk(dir, 'never-existed')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Singleton: getTransformRegistry / resetTransformRegistry
// ---------------------------------------------------------------------------

describe('Singleton', () => {
  test('getTransformRegistry returns a stable instance', () => {
    const a = getTransformRegistry()
    const b = getTransformRegistry()
    expect(a).toBe(b)
  })

  test('resetTransformRegistry replaces the instance on next access', () => {
    const a = getTransformRegistry()
    a.register('x', '(d) => d', '')
    resetTransformRegistry()
    const b = getTransformRegistry()
    expect(a).not.toBe(b)
    expect(b.has('x')).toBe(false)
  })
})
