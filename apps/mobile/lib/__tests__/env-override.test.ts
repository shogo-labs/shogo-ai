// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

let stored: string | null = JSON.stringify({ env: 'staging' })

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('expo-constants', () => ({ default: { expoConfig: { hostUri: '192.168.1.5:8081' } } }))
mock.module('expo-secure-store', () => ({
  getItem: () => stored,
  setItemAsync: async (_key: string, value: string) => {
    stored = value
  },
  deleteItemAsync: async () => {
    stored = null
  },
}))

describe('normalizeOverrideUrl', () => {
  test('accepts http(s) and trims trailing slashes', async () => {
    const { normalizeOverrideUrl } = await import('../env-override')
    expect(normalizeOverrideUrl(' http://192.168.1.10:8002/ ')).toBe('http://192.168.1.10:8002')
    expect(normalizeOverrideUrl('https://studio.staging.shogo.ai//')).toBe('https://studio.staging.shogo.ai')
  })

  test('rejects other schemes and junk', async () => {
    const { normalizeOverrideUrl } = await import('../env-override')
    expect(normalizeOverrideUrl('')).toBeNull()
    expect(normalizeOverrideUrl('studio.shogo.ai')).toBeNull()
    expect(normalizeOverrideUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeOverrideUrl('ftp://example.com')).toBeNull()
  })
})

describe('parseEnvOverride', () => {
  test('presets always resolve to their canonical URL', async () => {
    const { parseEnvOverride, ENV_PRESETS } = await import('../env-override')
    expect(parseEnvOverride(JSON.stringify({ env: 'staging', url: 'https://evil.example' }))).toEqual({
      env: 'staging',
      url: ENV_PRESETS.staging.url,
    })
  })

  test('custom needs a valid URL', async () => {
    const { parseEnvOverride } = await import('../env-override')
    expect(parseEnvOverride(JSON.stringify({ env: 'custom', url: 'http://10.0.0.2:8002/' }))).toEqual({
      env: 'custom',
      url: 'http://10.0.0.2:8002',
    })
    expect(parseEnvOverride(JSON.stringify({ env: 'custom', url: 'nope' }))).toBeNull()
  })

  test('ignores missing or malformed values', async () => {
    const { parseEnvOverride } = await import('../env-override')
    expect(parseEnvOverride(null)).toBeNull()
    expect(parseEnvOverride('{not json')).toBeNull()
    expect(parseEnvOverride(JSON.stringify({ env: 'qa' }))).toBeNull()
  })
})

describe('env key, auth prefix and telemetry', () => {
  test('default auth prefix stays exactly "shogo" so existing sessions survive', async () => {
    const { authStoragePrefixFor } = await import('../env-override')
    expect(authStoragePrefixFor('default')).toBe('shogo')
    expect(authStoragePrefixFor('staging')).toBe('shogo_staging')
    expect(authStoragePrefixFor('custom')).toBe('shogo_custom')
  })

  test('an override matching the build default shares the default session', async () => {
    const { resolveActiveEnvKey, ENV_PRESETS } = await import('../env-override')
    const prod = { env: 'production' as const, url: ENV_PRESETS.production.url }
    expect(resolveActiveEnvKey(null, 'https://studio.shogo.ai')).toBe('default')
    expect(resolveActiveEnvKey(prod, 'https://studio.shogo.ai/')).toBe('default')
    expect(resolveActiveEnvKey(prod, 'https://studio.staging.shogo.ai')).toBe('production')
    expect(resolveActiveEnvKey(prod, undefined)).toBe('production')
  })

  test('telemetry env follows the override', async () => {
    const { telemetryEnvFor } = await import('../env-override')
    expect(telemetryEnvFor('default', 'production_app')).toBe('production_app')
    expect(telemetryEnvFor('staging', 'production_app')).toBe('staging_app')
  })
})

describe('API_URL precedence', () => {
  test('a stored override beats EXPO_PUBLIC_API_URL and LAN inference', async () => {
    process.env.EXPO_PUBLIC_API_URL = 'https://studio.shogo.ai'
    const { API_URL } = await import('../api-url')
    expect(API_URL).toBe('https://studio.staging.shogo.ai')
  })

  test('setEnvOverride persists and clears the stored value', async () => {
    const { setEnvOverride, parseEnvOverride } = await import('../env-override')
    await setEnvOverride({ env: 'custom', url: 'http://10.0.0.2:8002' })
    expect(parseEnvOverride(stored)).toEqual({ env: 'custom', url: 'http://10.0.0.2:8002' })
    await setEnvOverride(null)
    expect(stored).toBeNull()
  })
})
