// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Response Transform Registry
 *
 * Allows the agent to register TypeScript transform functions that process
 * large tool responses (e.g. from Composio) before they hit the truncation
 * limit. Transforms run in a sandboxed vm context with a timeout to prevent
 * runaway code.
 */

import { runInNewContext } from 'node:vm'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResponseTransform {
  toolSlug: string
  description: string
  transformFn: string
  createdAt: number
}

interface CompiledTransform {
  meta: ResponseTransform
  fn: (data: unknown) => unknown
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BANNED_TOKENS = [
  'require', 'import', 'process', 'Bun', 'fetch', 'eval',
  'Function', 'globalThis', '__dirname', '__filename',
  'XMLHttpRequest', 'WebSocket', 'Worker', 'SharedArrayBuffer',
  'Atomics', 'Proxy', 'Reflect',
]

const VM_TIMEOUT_MS = 2000

const SANDBOX_GLOBALS = {
  JSON,
  Math,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Map,
  Set,
  RegExp,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  undefined,
  NaN,
  Infinity,
}

function validateTransformSource(source: string): void {
  for (const token of BANNED_TOKENS) {
    const pattern = new RegExp(`\\b${token}\\b`)
    if (pattern.test(source)) {
      throw new Error(`Transform contains banned token: "${token}"`)
    }
  }
}

function compileTransform(source: string): (data: unknown) => unknown {
  validateTransformSource(source)

  return (data: unknown) => {
    const sandbox = { ...SANDBOX_GLOBALS, data }
    const code = `(${source})(data)`
    return runInNewContext(code, sandbox, { timeout: VM_TIMEOUT_MS })
  }
}

// ---------------------------------------------------------------------------
// Smart JSON Truncation
// ---------------------------------------------------------------------------

const LARGE_STRING_FIELDS = new Set([
  'body', 'description', 'content', 'text', 'message', 'html',
  'html_body', 'plain_text', 'raw', 'diff', 'patch', 'readme',
  'bio', 'notes', 'comment', 'full_text', 'markdown',
])

const MAX_STRING_FIELD_CHARS = 500

/**
 * JSON-aware truncation that preserves structure instead of cutting raw strings.
 * 1. Limits array items to fit within budget
 * 2. Strips large string fields (body, description, etc.)
 * 3. Adds _meta with counts of what was omitted
 */
export function smartTruncateJson(data: unknown, maxChars: number = 12000): { result: string; truncated: boolean } {
  const full = JSON.stringify(data)
  if (full.length <= maxChars) {
    return { result: full, truncated: false }
  }

  const cloned = JSON.parse(full)
  const omittedFields: string[] = []

  stripLargeStrings(cloned, omittedFields)

  const afterStrip = JSON.stringify(cloned)
  if (afterStrip.length <= maxChars) {
    return { result: afterStrip, truncated: true }
  }

  const mainArray = findLargestArray(cloned)
  if (mainArray) {
    const { obj, key } = mainArray
    const arr = obj[key] as unknown[]
    const totalItems = arr.length

    let lo = 1
    let hi = arr.length
    let best = 1
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      obj[key] = arr.slice(0, mid)
      const size = JSON.stringify(cloned).length
      if (size <= maxChars - 100) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    obj[key] = arr.slice(0, best)

    if (!cloned._meta) cloned._meta = {}
    cloned._meta.totalItems = totalItems
    cloned._meta.showing = best
    if (omittedFields.length > 0) {
      cloned._meta.truncatedFields = [...new Set(omittedFields)]
    }

    const result = JSON.stringify(cloned)
    if (result.length <= maxChars) {
      return { result, truncated: true }
    }
  }

  // Last resort: raw truncation with valid JSON hint
  const headSize = Math.floor(maxChars * 0.8)
  const meta = JSON.stringify({
    _truncated: true,
    _originalSize: full.length,
    _omittedFields: [...new Set(omittedFields)],
  })
  const truncated = full.substring(0, headSize) + `\n\n[... ${full.length - headSize} chars truncated. Original size: ${full.length} chars ...]\n\n${meta}`
  return { result: truncated.substring(0, maxChars), truncated: true }
}

function stripLargeStrings(obj: any, omittedFields: string[], depth = 0): void {
  if (depth > 10 || obj == null || typeof obj !== 'object') return

  if (Array.isArray(obj)) {
    for (const item of obj) {
      stripLargeStrings(item, omittedFields, depth + 1)
    }
    return
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length > MAX_STRING_FIELD_CHARS) {
      if (LARGE_STRING_FIELDS.has(key.toLowerCase())) {
        obj[key] = value.substring(0, MAX_STRING_FIELD_CHARS) + `... [${value.length - MAX_STRING_FIELD_CHARS} chars omitted]`
        omittedFields.push(key)
      }
    } else if (typeof value === 'object' && value !== null) {
      stripLargeStrings(value, omittedFields, depth + 1)
    }
  }
}

function findLargestArray(obj: any, depth = 0): { obj: any; key: string } | null {
  if (depth > 5 || obj == null || typeof obj !== 'object') return null
  if (Array.isArray(obj)) return null

  let best: { obj: any; key: string; size: number } | null = null

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      const size = JSON.stringify(value).length
      if (!best || size > best.size) {
        best = { obj, key, size }
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = findLargestArray(value, depth + 1)
      if (nested) {
        const nestedSize = JSON.stringify(nested.obj[nested.key]).length
        if (!best || nestedSize > best.size) {
          best = { obj: nested.obj, key: nested.key, size: nestedSize }
        }
      }
    }
  }

  return best
}

// ---------------------------------------------------------------------------
// Last-Response Cache (LRU, for transform testing)
// ---------------------------------------------------------------------------

const MAX_CACHED_RESPONSES = 5

class LRUResponseCache {
  private cache = new Map<string, unknown>()
  private order: string[] = []

  set(toolSlug: string, data: unknown): void {
    if (this.cache.has(toolSlug)) {
      this.order = this.order.filter(k => k !== toolSlug)
    }
    this.cache.set(toolSlug, data)
    this.order.push(toolSlug)

    while (this.order.length > MAX_CACHED_RESPONSES) {
      const oldest = this.order.shift()!
      this.cache.delete(oldest)
    }
  }

  get(toolSlug: string): unknown | undefined {
    return this.cache.get(toolSlug)
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class TransformRegistry {
  private transforms = new Map<string, CompiledTransform>()
  private responseCache = new LRUResponseCache()

  register(toolSlug: string, transformFn: string, description: string): void {
    validateTransformSource(transformFn)
    const fn = compileTransform(transformFn)
    const meta: ResponseTransform = {
      toolSlug,
      description,
      transformFn,
      createdAt: Date.now(),
    }
    this.transforms.set(toolSlug, { meta, fn })
    console.log(`[Transforms] Registered transform for "${toolSlug}": ${description}`)
  }

  async execute(toolSlug: string, rawData: unknown): Promise<unknown> {
    const compiled = this.transforms.get(toolSlug)
    if (!compiled) return rawData

    try {
      return compiled.fn(rawData)
    } catch (err: any) {
      console.warn(`[Transforms] Transform for "${toolSlug}" failed: ${err.message}`)
      throw err
    }
  }

  /**
   * Execute an inline transform function (not from the registry).
   * Used by tool-backed API runtime for per-binding transforms.
   */
  async executeInline(transformFn: string, data: unknown): Promise<unknown> {
    const fn = compileTransform(transformFn)
    return fn(data)
  }

  get(toolSlug: string): ResponseTransform | undefined {
    return this.transforms.get(toolSlug)?.meta
  }

  has(toolSlug: string): boolean {
    return this.transforms.has(toolSlug)
  }

  remove(toolSlug: string): boolean {
    const had = this.transforms.has(toolSlug)
    this.transforms.delete(toolSlug)
    if (had) console.log(`[Transforms] Removed transform for "${toolSlug}"`)
    return had
  }

  list(): ResponseTransform[] {
    return Array.from(this.transforms.values()).map(c => c.meta)
  }

  // -- Last-response cache for testing transforms --

  cacheResponse(toolSlug: string, data: unknown): void {
    this.responseCache.set(toolSlug, data)
  }

  getCachedResponse(toolSlug: string): unknown | undefined {
    return this.responseCache.get(toolSlug)
  }

  /**
   * Register default transforms. Only registers if no user override exists.
   */
  registerDefaults(defaults: ResponseTransform[]): void {
    for (const def of defaults) {
      if (!this.transforms.has(def.toolSlug)) {
        try {
          this.register(def.toolSlug, def.transformFn, def.description)
        } catch (err: any) {
          console.warn(`[Transforms] Failed to register default for "${def.toolSlug}": ${err.message}`)
        }
      }
    }
  }

  // -- Persistence --

  persistToDisk(dir: string): void {
    mkdirSync(dir, { recursive: true })
    for (const { meta } of this.transforms.values()) {
      const filePath = join(dir, `${meta.toolSlug}.json`)
      writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8')
    }
  }

  loadFromDisk(dir: string): void {
    if (!existsSync(dir)) return

    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const filePath = join(dir, file)
        const raw = readFileSync(filePath, 'utf-8')
        const meta: ResponseTransform = JSON.parse(raw)
        if (meta.toolSlug && meta.transformFn) {
          this.register(meta.toolSlug, meta.transformFn, meta.description || '')
        }
      } catch (err: any) {
        console.warn(`[Transforms] Failed to load ${file}: ${err.message}`)
      }
    }
  }

  removeFromDisk(dir: string, toolSlug: string): void {
    const filePath = join(dir, `${toolSlug}.json`)
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let globalRegistry: TransformRegistry | null = null

export function getTransformRegistry(): TransformRegistry {
  if (!globalRegistry) {
    globalRegistry = new TransformRegistry()
  }
  return globalRegistry
}

export function resetTransformRegistry(): void {
  globalRegistry = null
}
