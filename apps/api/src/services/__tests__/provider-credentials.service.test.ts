// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-provider credential resolver tests.
 *
 * Covers the Tripo (3D) registration that landed with the admin provider-keys
 * UI (SHO-37) plus the precedence + masking contract every native provider
 * shares:
 *   - `SUPPORTED_NATIVE_PROVIDERS` is derived from the env-key map, so a
 *     provider the admin UI can render must appear here or its PUT no-ops
 *   - DB-stored (decrypted) key wins over the env var, which wins over null
 *   - read APIs only ever expose a mask + source, never the plaintext
 *   - an unknown provider id is rejected rather than silently stored
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

let store: Map<string, string>

const prismaStub: any = {
  platformSetting: {
    findMany: async ({ where }: any = {}) => {
      let entries = [...store.entries()]
      if (where?.key?.startsWith) entries = entries.filter(([k]) => k.startsWith(where.key.startsWith))
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

mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
// Deterministic, reversible "crypto" so the key round-trips without a real
// SECRETS_ENCRYPTION_KEY, and a mask shape that is easy to assert on.
mock.module('../../lib/secret-crypto', () => ({
  encryptSecret: (p: string) => `enc(${p})`,
  decryptSecret: (c: string) => c.replace(/^enc\(|\)$/g, ''),
  isSecretCryptoConfigured: () => true,
  maskSecret: (s: string) => `${s.slice(0, 4)}…${s.slice(-2)}`,
}))

const svc = await import('../provider-credentials.service')

const TRIPO_PLAINTEXT = 'tsk_live_tripo_secret_value'

beforeEach(async () => {
  store = new Map<string, string>()
  delete process.env.TRIPO_API_KEY
  await svc.invalidateProviderCredentials()
})

afterEach(() => {
  delete process.env.TRIPO_API_KEY
})

describe('SUPPORTED_NATIVE_PROVIDERS', () => {
  test('includes tripo alongside the LLM + image providers', () => {
    expect(svc.SUPPORTED_NATIVE_PROVIDERS).toContain('tripo')
    expect(svc.isNativeProvider('tripo')).toBe(true)
    expect(svc.NATIVE_PROVIDER_ENV_KEY.tripo).toBe('TRIPO_API_KEY')
  })

  test('rejects an unknown provider id', async () => {
    await expect(svc.setNativeProviderKey('nope', 'x', 'admin-1')).rejects.toThrow(
      'unsupported provider: nope',
    )
    expect(store.size).toBe(0)
  })
})

describe('tripo key precedence', () => {
  test('a stored key is returned and beats the env fallback', async () => {
    process.env.TRIPO_API_KEY = 'tsk_from_env'
    await svc.invalidateProviderCredentials()
    expect(svc.getNativeProviderApiKeySync('tripo')).toBe('tsk_from_env')

    await svc.setNativeProviderKey('tripo', TRIPO_PLAINTEXT, 'admin-1')
    expect(svc.getNativeProviderApiKeySync('tripo')).toBe(TRIPO_PLAINTEXT)
    // Stored encrypted, never as plaintext.
    expect(store.get('provider-key.tripo')).toBe(`enc(${TRIPO_PLAINTEXT})`)
  })

  test('clearing falls back to env, then to null', async () => {
    await svc.setNativeProviderKey('tripo', TRIPO_PLAINTEXT, 'admin-1')
    process.env.TRIPO_API_KEY = 'tsk_from_env'

    await svc.setNativeProviderKey('tripo', null, 'admin-1')
    expect(store.has('provider-key.tripo')).toBe(false)
    expect(svc.getNativeProviderApiKeySync('tripo')).toBe('tsk_from_env')

    delete process.env.TRIPO_API_KEY
    expect(svc.getNativeProviderApiKeySync('tripo')).toBeNull()
  })
})

describe('tripo key info', () => {
  test('reports source db with a mask that does not leak the plaintext', async () => {
    await svc.setNativeProviderKey('tripo', TRIPO_PLAINTEXT, 'admin-1')
    const info = svc.getNativeProviderKeyInfoSync('tripo')

    expect(info.configured).toBe(true)
    expect(info.source).toBe('db')
    expect(info.mask).toBe('tsk_…ue')
    expect(info.mask).not.toContain('live_tripo_secret')
  })

  test('reports source env when only the env var is set', async () => {
    process.env.TRIPO_API_KEY = 'tsk_from_env'
    const info = svc.getNativeProviderKeyInfoSync('tripo')

    expect(info).toEqual({ configured: true, mask: 'tsk_…nv', source: 'env' })
  })

  test('reports unconfigured when neither source is present', () => {
    expect(svc.getNativeProviderKeyInfoSync('tripo')).toEqual({
      configured: false,
      mask: '',
      source: null,
    })
  })
})
