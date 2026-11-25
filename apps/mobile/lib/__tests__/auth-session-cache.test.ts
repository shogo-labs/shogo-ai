// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The device's session mirror (SHO-580): readable synchronously on the first
 * frame, written from the provider, and gone on sign-out.
 */

import { resolve } from "node:path"
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
mock.module(resolve(import.meta.dir, '../storage'), () => ({
  getStorageItem: async (key: string) => store.get(key) ?? null,
  removeStorageItem: async (key: string) => {
    store.delete(key)
  },
  setStorageItem: async (key: string, value: string) => {
    store.set(key, value)
  },
  setStorageJson: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value))
  },
}))

let cache: typeof import('../auth-session-cache')
beforeAll(async () => {
  cache = await import('../auth-session-cache')
})

const USER = { id: 'user-1', name: 'User One', email: 'one@example.com' }

afterEach(async () => {
  await cache.clearAuthSessionCache()
  cache.resetAuthSessionCacheForTests()
  store.clear()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('auth session cache', () => {
  test('nothing is cached before the device is read', async () => {
    expect(cache.readCachedAuthUser()).toBeNull()
  })

  test('a remembered user is readable synchronously, and survives a relaunch', async () => {
    cache.rememberAuthUser(USER)
    expect(cache.readCachedAuthUser()?.id).toBe('user-1')

    await flush()
    // A new JS session: the mirror is gone, the device still holds the user.
    cache.resetAuthSessionCacheForTests()
    expect(cache.readCachedAuthUser()).toBeNull()
    await cache.hydrateAuthSessionCache()
    expect(cache.readCachedAuthUser()).toEqual(USER)
  })

  test('a null never erases a stored user — only a sign-out does', async () => {
    cache.rememberAuthUser(USER)
    await flush()
    cache.resetAuthSessionCacheForTests()
    await cache.hydrateAuthSessionCache()

    cache.rememberAuthUser(null)
    await flush()
    cache.resetAuthSessionCacheForTests()
    await cache.hydrateAuthSessionCache()
    expect(cache.readCachedAuthUser()).toEqual(USER)
  })

  test('clearing removes it from the device', async () => {
    cache.rememberAuthUser(USER)
    await flush()
    await cache.clearAuthSessionCache()

    cache.resetAuthSessionCacheForTests()
    await cache.hydrateAuthSessionCache()
    expect(cache.readCachedAuthUser()).toBeNull()
  })

  test('the onboarding answer is per user', async () => {
    cache.rememberAuthUser(USER)
    expect(cache.readCachedOnboardingCompleted('user-1')).toBeNull()

    cache.rememberOnboardingCompleted('user-1', true)
    expect(cache.readCachedOnboardingCompleted('user-1')).toBe(true)
    expect(cache.readCachedOnboardingCompleted('someone-else')).toBeNull()

    await flush()
    cache.resetAuthSessionCacheForTests()
    await cache.hydrateAuthSessionCache()
    expect(cache.readCachedOnboardingCompleted('user-1')).toBe(true)
    expect(cache.readCachedAuthUser()).toEqual(USER)
  })

  test('a corrupted record reads as no session instead of throwing', async () => {
    cache.rememberAuthUser(USER)
    await flush()
    for (const key of store.keys()) store.set(key, '{not json')

    cache.resetAuthSessionCacheForTests()
    await cache.hydrateAuthSessionCache()
    expect(cache.readCachedAuthUser()).toBeNull()
  })
})
