// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Storage abstraction that always works:
 * - Uses localStorage when available (normal browsers)
 * - Falls back to an in-memory Map when localStorage is blocked
 *   (private/incognito mode, restricted iframe/webview, SSR)
 *
 * The fallback keeps data alive for the duration of the page session,
 * so preferences, pending template IDs, attribution, etc. still function
 * within a single visit even when persistence is impossible.
 */

interface StorageBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

class MemoryStorage implements StorageBackend {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }
}

function probe(storage: () => Storage | undefined, testKey: string): StorageBackend | null {
  try {
    const store = storage()
    if (!store) return null
    store.setItem(testKey, '1')
    store.removeItem(testKey)
    return store
  } catch {
    return null
  }
}

function resolveBackend(): StorageBackend {
  if (typeof window === 'undefined') return new MemoryStorage()
  return probe(() => window.localStorage, '__shogo_storage_probe__') ?? new MemoryStorage()
}

/**
 * Tab-scoped storage (`sessionStorage`): shared with nothing, survives reload
 * in this tab, and is copied by "Duplicate tab". Used for state that must not
 * follow the person into another tab. Falls back to the same in-memory map
 * when the browser blocks it.
 */
function resolveSessionBackend(): StorageBackend {
  if (typeof window === 'undefined') return new MemoryStorage()
  return probe(() => window.sessionStorage, '__shogo_session_probe__') ?? new MemoryStorage()
}

let backend: StorageBackend | null = null
let sessionBackend: StorageBackend | null = null

function getBackend(): StorageBackend {
  if (!backend) backend = resolveBackend()
  return backend
}

function getSessionBackend(): StorageBackend {
  if (!sessionBackend) sessionBackend = resolveSessionBackend()
  return sessionBackend
}

export const safeGetItem = (key: string): string | null => {
  return getBackend().getItem(key)
}

export const safeSetItem = (key: string, value: string): void => {
  getBackend().setItem(key, value)
}

export const safeRemoveItem = (key: string): void => {
  getBackend().removeItem(key)
}

export const safeSessionGetItem = (key: string): string | null => {
  return getSessionBackend().getItem(key)
}

export const safeSessionSetItem = (key: string, value: string): void => {
  getSessionBackend().setItem(key, value)
}

export const safeSessionRemoveItem = (key: string): void => {
  getSessionBackend().removeItem(key)
}
