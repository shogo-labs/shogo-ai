// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate content-CPM settings service tests.
 *
 * Covers the DB-backed config that replaced the env vars:
 *   - defaults when no rows are seeded (feature off, fail-closed)
 *   - read of seeded values + caching/invalidation
 *   - setContentSettings write/clear semantics (null deletes the row)
 *   - resolveCpmCents precedence: creator override > per-platform > global
 *   - EnsembleData token store/clear (encrypted) + info masking
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

type Row = Record<string, any>

let store: Map<string, string>

const prismaStub: any = {
  platformSetting: {
    findMany: async ({ where }: any = {}) => {
      let entries = [...store.entries()]
      if (where?.key?.startsWith) entries = entries.filter(([k]) => k.startsWith(where.key.startsWith))
      if (where?.key?.in) entries = entries.filter(([k]) => where.key.in.includes(k))
      return entries.map(([key, value]) => ({ key, value }))
    },
    findUnique: async ({ where }: any) => {
      const value = store.get(where.key)
      return value != null ? { key: where.key, value } : null
    },
    upsert: async ({ where, create, update }: any) => {
      const existed = store.has(where.key)
      store.set(where.key, String((existed ? update : create).value))
      return { key: where.key, value: store.get(where.key) }
    },
    deleteMany: async ({ where }: any) => {
      if (where?.key) store.delete(where.key)
      return {}
    },
  },
}

// Deterministic, reversible "crypto" so the token round-trips in tests.
mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('../../lib/secret-crypto', () => ({
  encryptSecret: (p: string) => `enc(${p})`,
  decryptSecret: (c: string) => c.replace(/^enc\(|\)$/g, ''),
  isSecretCryptoConfigured: () => true,
  maskSecret: (s: string) => `${s.slice(0, 2)}…${s.slice(-2)}`,
}))
// Include the full social-content surface (not just the two names this module
// imports) so the shared bun test process doesn't end up with a partial mock
// when this file runs alongside others that import the same module.
class FakeProviderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'SocialProviderError'
  }
}
mock.module('../social-content', () => ({
  ENSEMBLEDATA_SETTING_KEY: 'provider-key.ensembledata',
  invalidateSocialContentProvider: () => {},
  getConfiguredProviderName: async () => 'ensembledata',
  getSocialContentProvider: async () => ({ name: 'fake' }),
  SocialProviderError: FakeProviderError,
}))

const svc = await import('../affiliate-content-settings.service')

beforeEach(() => {
  store = new Map<string, string>()
  svc.invalidateContentSettings()
})

afterEach(() => {
  svc.invalidateContentSettings()
})

describe('getContentSettings', () => {
  test('returns fail-closed defaults when nothing is seeded', async () => {
    const s = await svc.getContentSettings({ force: true })
    expect(s.enabled).toBe(false)
    expect(s.provider).toBe('ensembledata')
    expect(s.cpmCents).toBe(svc.CONTENT_SETTING_DEFAULTS.cpmCents)
    expect(s.holdDays).toBe(7)
    expect(s.cpmCentsByPlatform).toEqual({ instagram: null, tiktok: null })
  })

  test('reads seeded values', async () => {
    store.set('affiliate.content.enabled', 'true')
    store.set('affiliate.content.provider', 'official')
    store.set('affiliate.content.cpmCents', '150')
    store.set('affiliate.content.instagram.cpmCents', '200')
    const s = await svc.getContentSettings({ force: true })
    expect(s.enabled).toBe(true)
    expect(s.provider).toBe('official')
    expect(s.cpmCents).toBe(150)
    expect(s.cpmCentsByPlatform.instagram).toBe(200)
    expect(s.cpmCentsByPlatform.tiktok).toBe(null)
  })
})

describe('setContentSettings', () => {
  test('writes values and clears with null', async () => {
    await svc.setContentSettings({ enabled: true, cpmCents: 120, holdDays: 3 }, 'admin-1')
    expect(store.get('affiliate.content.enabled')).toBe('true')
    expect(store.get('affiliate.content.cpmCents')).toBe('120')
    expect(store.get('affiliate.content.holdDays')).toBe('3')

    const after = await svc.setContentSettings({ cpmCents: null }, 'admin-1')
    expect(store.has('affiliate.content.cpmCents')).toBe(false)
    // Cleared → reverts to the built-in default.
    expect(after.cpmCents).toBe(svc.CONTENT_SETTING_DEFAULTS.cpmCents)
  })

  test('rejects invalid numeric input', async () => {
    await expect(svc.setContentSettings({ postsPerAccount: 0 }, 'admin-1')).rejects.toThrow()
    await expect(svc.setContentSettings({ cpmCents: -5 }, 'admin-1')).rejects.toThrow()
  })
})

describe('resolveCpmCents', () => {
  test('precedence: creator override > per-platform > global', async () => {
    const s = await svc.getContentSettings({ force: true })
    const withPlatform = {
      ...s,
      cpmCents: 100,
      cpmCentsByPlatform: { instagram: 200, tiktok: null },
    }
    expect(svc.resolveCpmCents(withPlatform, 'instagram')).toBe(200) // per-platform
    expect(svc.resolveCpmCents(withPlatform, 'tiktok')).toBe(100) // global fallback
    expect(svc.resolveCpmCents(withPlatform, 'instagram', 350)).toBe(350) // creator wins
    expect(svc.resolveCpmCents(withPlatform, 'tiktok', null)).toBe(100) // null override ignored
  })
})

describe('EnsembleData token', () => {
  test('stores encrypted and reports configured', async () => {
    await svc.setEnsembleDataToken('secret-token', 'admin-1')
    expect(store.get('provider-key.ensembledata')).toBe('enc(secret-token)')
    const info = await svc.getEnsembleDataTokenInfo()
    expect(info.configured).toBe(true)
    expect(info.source).toBe('db')
  })

  test('clears with null/empty', async () => {
    await svc.setEnsembleDataToken('secret-token', 'admin-1')
    await svc.setEnsembleDataToken(null, 'admin-1')
    expect(store.has('provider-key.ensembledata')).toBe(false)
    const info = await svc.getEnsembleDataTokenInfo()
    expect(info.configured).toBe(false)
  })
})
