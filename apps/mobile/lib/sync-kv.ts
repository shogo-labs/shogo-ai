// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Small synchronous key/value store for values a route has to read *during
 * render* — the auth front door decides Sign In vs Sign Up and replays a
 * marketing link's intent before it draws its first frame, so an async
 * AsyncStorage read (the app's normal storage path, `lib/storage.ts`) would
 * mean a spinner or a flash of the wrong tab.
 *
 * Web maps onto the browser's own stores, so the two stores behave exactly as
 * their names promise: `session` dies with the tab, `local` survives it.
 * Native has no such pair: `local` goes to SecureStore and `session` is
 * process memory, which is the same lifetime a native tab has (the OAuth round
 * trip returns to the same JS session).
 */
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

export type SyncStore = 'local' | 'session'

const SESSION_MIRROR = new Map<string, string>()

function webStorage(store: SyncStore): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  try {
    return store === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

function nativeKey(store: SyncStore, key: string): string {
  return `shogo:${store}:${key}`
}

export function readSyncValue(store: SyncStore, key: string): string | null {
  const web = webStorage(store)
  if (web) {
    try {
      return web.getItem(key)
    } catch {
      return null
    }
  }
  if (store === 'session') return SESSION_MIRROR.get(key) ?? null
  try {
    return SecureStore.getItem(nativeKey(store, key))
  } catch {
    return null
  }
}

export function writeSyncValue(store: SyncStore, key: string, value: string): void {
  const web = webStorage(store)
  if (web) {
    try {
      web.setItem(key, value)
    } catch {}
    return
  }
  if (store === 'session') {
    SESSION_MIRROR.set(key, value)
    return
  }
  try {
    SecureStore.setItem(nativeKey(store, key), value)
  } catch {}
}

export function removeSyncValue(store: SyncStore, key: string): void {
  const web = webStorage(store)
  if (web) {
    try {
      web.removeItem(key)
    } catch {}
    return
  }
  if (store === 'session') {
    SESSION_MIRROR.delete(key)
    return
  }
  try {
    // The sync API has no delete; a fire-and-forget async delete is enough for
    // something only ever removed on an explicit reset.
    void SecureStore.deleteItemAsync(nativeKey(store, key)).catch(() => {})
  } catch {}
}
