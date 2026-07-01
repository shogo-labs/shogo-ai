// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRO #1 — generated CRUD response shape vs naive frontend consumer.
 *
 * Production symptom (top runtime crash in generated apps):
 *   "X.filter is not a function", "X.map is not a function",
 *   "Cannot read properties of undefined (reading '...')".
 *
 * Root cause: the auto-generated CRUD list route returns a WRAPPED envelope
 *   { ok: true, items, total }            (routes-generator.ts:301)
 * (single-record routes return { ok: true, data }, errors return { error })
 * but agent-written React code routinely consumes the JSON body as a RAW
 * array — `const data = await res.json(); data.filter(...)` — which throws.
 *
 * This is reinforced by docs-generator.ts:266, which documents the LIST
 * response as a bare array `[{ ... }]`, actively steering the model wrong.
 *
 * The test runs the REAL generators to pin the contract + the contradiction,
 * then reproduces the exact runtime crash a browser fetch would hit. No HTTP
 * server / hono dependency needed: a browser's `await res.json()` yields the
 * parsed body verbatim, which is all the consumer crash depends on.
 */
import { describe, it, expect } from 'bun:test'
import { generateModelRoutes } from '../routes-generator'
import { generateModelDoc } from '../docs-generator'
import type { PrismaModel } from '../prisma-generator'

const Widget: PrismaModel = {
  name: 'Widget',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
}

/**
 * Faithful stand-in for `await fetch(url).then(r => r.json())`: a real Response
 * whose body is exactly what the generated route emits. The parsed value is
 * what the agent-written component actually operates on.
 */
async function fetchJson(body: unknown): Promise<any> {
  const res = new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
  return res.json()
}

describe('REPRO #1 — CRUD envelope vs naive consumer', () => {
  it('premise: the generated LIST route returns { ok, items, total } — not a raw array', () => {
    const src = generateModelRoutes(Widget)!.code
    expect(src).toContain('return sendJson(c, { ok: true, items, total })') // LIST
    expect(src).toContain('return sendJson(c, { ok: true, data: item })') // GET/CREATE/UPDATE
    // Error path carries no `items` at all:
    expect(src).toContain('{ error: { code: "list_failed", message: error.message } }')
  })

  it('FIXED: the generated DOCS now document the real { ok, items, total } envelope', () => {
    const doc = generateModelDoc(Widget, [Widget], []).content
    // The LIST 200 response is now an object with the array under `items` …
    expect(doc).toMatch(/"ok": true,[\s\S]*?"items": \[/)
    // … and the docs explicitly steer the reader to `res.items ?? []`.
    expect(doc).toContain('res.items ?? []')
    // Regression guard: the LIST response must NOT be documented as a bare,
    // top-level array (the old contradiction that produced `.filter` crashes).
    expect(doc).not.toMatch(/```json\s*\n\s*\[\{/)
  })

  it('crash: treating the LIST body as an array throws "filter is not a function"', async () => {
    // The single most common agent-written pattern:
    //   const data = await (await fetch('/api/widgets')).json()
    //   setRows(data.filter(...))
    const data = await fetchJson({ ok: true, items: [{ id: '1', name: 'a' }], total: 1 })
    expect(() => (data as any[]).filter((w: any) => w.name === 'a')).toThrow(
      /filter is not a function/,
    )
  })

  it('crash variant: an error/4xx body has no `items` → "undefined ... map" crash', async () => {
    // When the route errors it returns { error: {...} } with NO `items`, so
    // even code that reaches for `res.items` blows up on the next `.map`.
    const data = await fetchJson({ error: { code: 'list_failed', message: 'boom' } })
    expect(() => (data.items as any[]).map((w: any) => w.id)).toThrow(
      /map is not a function|undefined is not an object|Cannot read properties of undefined/,
    )
  })

  it('correct shape: unwrapping `res.items` (with a fallback) is crash-free', async () => {
    const ok = await fetchJson({ ok: true, items: [{ id: '1', name: 'a' }], total: 1 })
    const err = await fetchJson({ error: { code: 'list_failed', message: 'boom' } })
    expect((ok.items ?? []).filter((w: any) => w.name === 'a')).toHaveLength(1)
    expect((err.items ?? []).map((w: any) => w.id)).toEqual([]) // defensive: no throw
  })
})
