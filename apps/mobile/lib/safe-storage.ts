// SPDX-License-Identifier: AGPL-3.0-or-later
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

function resolveBackend(): StorageBackend {
  if (typeof window === 'undefined') return new MemoryStorage()
  try {
    const testKey = '__shogo_storage_probe__'
    window.localStorage.setItem(testKey, '1')
    window.localStorage.removeItem(testKey)
    return window.localStorage
  } catch {
    return new MemoryStorage()
  }
}

let backend: StorageBackend | null = null

function getBackend(): StorageBackend {
  if (!backend) backend = resolveBackend()
  return backend
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
