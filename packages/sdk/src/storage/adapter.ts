/**
 * Storage Adapter Interface
 *
 * Allows using different storage backends across platforms:
 * - Web: localStorage
 * - React Native: AsyncStorage
 * - Node.js/SSR: No-op or custom
 */

import type { StorageAdapter } from '../types.js'

export type { StorageAdapter }

/**
 * Detect if we're running in a browser environment
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

/**
 * Get the default storage adapter based on the environment
 */
export function getDefaultStorageAdapter(): StorageAdapter {
  if (isBrowser()) {
    return new WebStorageAdapter()
  }
  return new NoOpStorageAdapter()
}

/**
 * Web localStorage adapter (synchronous)
 * Used automatically in browser environments
 */
export class WebStorageAdapter implements StorageAdapter {
  private prefix: string

  constructor(prefix = 'shogo_') {
    this.prefix = prefix
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`
  }

  getItem(key: string): string | null {
    try {
      return localStorage.getItem(this.getKey(key))
    } catch {
      return null
    }
  }

  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(this.getKey(key), value)
    } catch {
      // Storage might be full or disabled
    }
  }

  removeItem(key: string): void {
    try {
      localStorage.removeItem(this.getKey(key))
    } catch {
      // Ignore errors
    }
  }

  clear(): void {
    try {
      // Only clear items with our prefix
      const keysToRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(this.prefix)) {
          keysToRemove.push(key)
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key))
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Async storage adapter wrapper (for React Native AsyncStorage)
 *
 * Usage:
 * ```typescript
 * import AsyncStorage from '@react-native-async-storage/async-storage'
 * const storage = new AsyncStorageAdapter(AsyncStorage)
 * ```
 */
export class AsyncStorageAdapter implements StorageAdapter {
  private asyncStorage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
    clear?(): Promise<void>
  }
  private prefix: string

  constructor(
    asyncStorage: {
      getItem(key: string): Promise<string | null>
      setItem(key: string, value: string): Promise<void>
      removeItem(key: string): Promise<void>
      clear?(): Promise<void>
    },
    prefix = 'shogo_'
  ) {
    this.asyncStorage = asyncStorage
    this.prefix = prefix
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await this.asyncStorage.getItem(this.getKey(key))
    } catch {
      return null
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await this.asyncStorage.setItem(this.getKey(key), value)
    } catch {
      // Storage might be unavailable
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.asyncStorage.removeItem(this.getKey(key))
    } catch {
      // Ignore errors
    }
  }

  async clear(): Promise<void> {
    if (this.asyncStorage.clear) {
      try {
        await this.asyncStorage.clear()
      } catch {
        // Ignore errors
      }
    }
  }
}

/**
 * No-op storage adapter (for server-side or when storage is disabled)
 * Used automatically on Node.js or when no storage is available
 */
export class NoOpStorageAdapter implements StorageAdapter {
  getItem(_key: string): null {
    return null
  }

  setItem(_key: string, _value: string): void {
    // No-op
  }

  removeItem(_key: string): void {
    // No-op
  }

  clear(): void {
    // No-op
  }
}

/**
 * In-memory storage adapter (for testing or temporary storage)
 */
export class MemoryStorageAdapter implements StorageAdapter {
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

  clear(): void {
    this.store.clear()
  }
}
