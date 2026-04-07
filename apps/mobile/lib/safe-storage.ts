// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Safe wrappers around localStorage that gracefully handle:
 * - SSR / environments where `window` is undefined
 * - SecurityError in private/incognito mode or restricted iframe/webview contexts
 *
 * The `typeof localStorage !== 'undefined'` check alone is insufficient:
 * some browsers define the property but throw SecurityError on any access.
 */

export const safeGetItem = (key: string): string | null => {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export const safeSetItem = (key: string, value: string): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode, quota exceeded, etc.)
  }
}

export const safeRemoveItem = (key: string): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(key)
  } catch {
    // Storage unavailable
  }
}
