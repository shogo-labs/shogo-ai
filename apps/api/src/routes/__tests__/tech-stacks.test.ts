// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * tech-stacks route — full coverage.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

let stacks: any[] = []
let metaByid: Map<string, any> = new Map()

mock.module('../../../../../packages/agent-runtime/src/workspace-defaults', () => ({
  listTechStacks: () => stacks,
  loadTechStackMeta: (id: string) => metaByid.get(id) ?? null,
}))

import { techStackRoutes } from '../tech-stacks'

function app() {
  const { Hono } = require('hono')
  const a = new Hono()
  a.route('/api', techStackRoutes())
  return a
}

beforeEach(() => {
  stacks = []
  metaByid = new Map()
})

describe('GET /api/tech-stacks', () => {
  test('returns empty list', async () => {
    const r = await app().request('/api/tech-stacks')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ stacks: [] })
  })
  test('returns whatever listTechStacks() yields', async () => {
    stacks = [{ id: 'vite-react' }, { id: 'expo' }]
    const r = await app().request('/api/tech-stacks')
    expect((await r.json() as any).stacks).toEqual(stacks)
  })
})

describe('GET /api/tech-stacks/:id', () => {
  test('404 when stack not found', async () => {
    const r = await app().request('/api/tech-stacks/missing')
    expect(r.status).toBe(404)
    expect((await r.json() as any).error).toBe('Tech stack not found')
  })
  test('200 with stack meta when found', async () => {
    metaByid.set('vite-react', { id: 'vite-react', label: 'Vite + React' })
    const r = await app().request('/api/tech-stacks/vite-react')
    expect(r.status).toBe(200)
    expect((await r.json() as any).stack.label).toBe('Vite + React')
  })
})
