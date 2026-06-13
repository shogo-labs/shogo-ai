// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * admin-scopes lib tests: catalog shape, scope validation/normalization, and
 * getAdminAccess resolution. prisma is mocked so the module's top-level client
 * is never instantiated against a real database.
 *
 * Run: bun test apps/api/src/lib/__tests__/admin-scopes.test.ts
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let findUniqueImpl: (args: any) => Promise<any> = async () => null

mock.module('../prisma', () => ({
  prisma: {
    user: {
      findUnique: (args: any) => findUniqueImpl(args),
    },
  },
}))

const {
  ADMIN_SCOPES,
  ADMIN_SCOPE_IDS,
  isAdminScope,
  normalizeAdminScopes,
  getAdminAccess,
  hasScope,
} = await import('../admin-scopes')

beforeEach(() => {
  findUniqueImpl = async () => null
})

describe('ADMIN_SCOPES catalog', () => {
  it('includes the analytics, marketing, ai, and creators scopes we ship today', () => {
    expect(ADMIN_SCOPE_IDS).toContain('analytics:read')
    expect(ADMIN_SCOPE_IDS).toContain('marketing:read')
    expect(ADMIN_SCOPE_IDS).toContain('ai:read')
    expect(ADMIN_SCOPE_IDS).toContain('creators:read')
    expect(ADMIN_SCOPE_IDS).toContain('creators:write')
  })

  it('has a unique id and a non-empty label for every entry', () => {
    const ids = ADMIN_SCOPES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of ADMIN_SCOPES) {
      expect(typeof s.label).toBe('string')
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })
})

describe('isAdminScope', () => {
  it('accepts known scopes and rejects everything else', () => {
    expect(isAdminScope('analytics:read')).toBe(true)
    expect(isAdminScope('creators:read')).toBe(true)
    expect(isAdminScope('foo:bar')).toBe(false)
    expect(isAdminScope('')).toBe(false)
    expect(isAdminScope(null)).toBe(false)
    expect(isAdminScope(42)).toBe(false)
  })
})

describe('normalizeAdminScopes', () => {
  it('passes through a clean array of known scopes', () => {
    expect(normalizeAdminScopes(['analytics:read'])).toEqual(['analytics:read'])
  })

  it('parses a JSON-encoded string (SQLite shape)', () => {
    expect(normalizeAdminScopes('["creators:read"]')).toEqual(['creators:read'])
  })

  it('drops unknown scopes and dedupes', () => {
    expect(
      normalizeAdminScopes(['analytics:read', 'analytics:read', 'nope:nope']),
    ).toEqual(['analytics:read'])
  })

  it('returns [] for malformed / non-array input', () => {
    expect(normalizeAdminScopes('not json')).toEqual([])
    expect(normalizeAdminScopes(null)).toEqual([])
    expect(normalizeAdminScopes(undefined)).toEqual([])
    expect(normalizeAdminScopes(123)).toEqual([])
    expect(normalizeAdminScopes({})).toEqual([])
  })
})

describe('getAdminAccess', () => {
  it('reports super_admin as holding every scope', async () => {
    findUniqueImpl = async () => ({ role: 'super_admin', adminScopes: [] })
    const access = await getAdminAccess('admin-1')
    expect(access.isSuperAdmin).toBe(true)
    expect(access.scopes).toEqual([...ADMIN_SCOPE_IDS])
    expect(hasScope(access, 'analytics:read')).toBe(true)
    expect(hasScope(access, 'creators:read')).toBe(true)
  })

  it('returns the exact granted scopes for a partial admin', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: ['analytics:read'] })
    const access = await getAdminAccess('user-1')
    expect(access.isSuperAdmin).toBe(false)
    expect(access.scopes).toEqual(['analytics:read'])
    expect(hasScope(access, 'analytics:read')).toBe(true)
    expect(hasScope(access, 'creators:read')).toBe(false)
  })

  it('returns no access for a plain user', async () => {
    findUniqueImpl = async () => ({ role: 'user', adminScopes: [] })
    const access = await getAdminAccess('user-1')
    expect(access).toEqual({ isSuperAdmin: false, scopes: [] })
  })

  it('returns no access when the user does not exist', async () => {
    findUniqueImpl = async () => null
    const access = await getAdminAccess('ghost')
    expect(access).toEqual({ isSuperAdmin: false, scopes: [] })
  })

  it('selects role + adminScopes for the given user id', async () => {
    let captured: any
    findUniqueImpl = async (args) => {
      captured = args
      return { role: 'user', adminScopes: [] }
    }
    await getAdminAccess('the-id')
    expect(captured.where).toEqual({ id: 'the-id' })
    expect(captured.select).toEqual({ role: true, adminScopes: true })
  })
})
