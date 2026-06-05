// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (P0): regenerating `server.tsx` after a schema change clobbered
 * custom tenant-isolation middleware the agent had added directly to the file,
 * silently removing a security guard.
 *
 * These tests pin the fixed behavior: code inside SHOGO:CUSTOM markers survives
 * regeneration.
 */
import { describe, it, expect } from 'bun:test'
import {
  mergeProtectedRegions,
  extractProtectedRegions,
  CUSTOM_REGION_START,
  CUSTOM_REGION_END,
} from '../server-custom-regions'

const EXISTING = [
  "import { Hono } from 'hono'",
  'const app = new Hono()',
  `${CUSTOM_REGION_START} tenant-guard`,
  "app.use('*', async (c, next) => {",
  "  if (!c.req.header('x-tenant-id')) return c.json({ error: 'forbidden' }, 403)",
  '  await next()',
  '})',
  CUSTOM_REGION_END,
  'export default app',
].join('\n')

// A regeneration that has no idea the custom middleware ever existed.
const REGENERATED = [
  "import { Hono } from 'hono'",
  'const app = new Hono()',
  '// (freshly generated CRUD routes, no custom middleware)',
  'export default app',
].join('\n')

describe('server custom-region preservation', () => {
  it('extracts protected regions with their label', () => {
    const regions = extractProtectedRegions(EXISTING)
    expect(regions.length).toBe(1)
    expect(regions[0].id).toBe('tenant-guard')
    expect(regions[0].body).toContain('x-tenant-id')
  })

  it('preserves custom tenant middleware through regeneration', () => {
    const merged = mergeProtectedRegions(EXISTING, REGENERATED)
    expect(merged).toContain('x-tenant-id')
    expect(merged).toContain('403')
  })

  it('is a no-op when the existing file has no protected regions', () => {
    const plain = ["const app = 1", 'export default app'].join('\n')
    expect(mergeProtectedRegions(plain, REGENERATED)).toBe(REGENERATED)
  })
})
