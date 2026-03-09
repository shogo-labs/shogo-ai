// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ephemeral store for passing image data between screens.
 *
 * Route params (expo-router) can't carry large base64 data URLs, so when the
 * home screen attaches images and navigates to a new project, we stash the
 * data here and the project layout picks it up once on mount.
 *
 * Uses both a module-level variable (fastest) and sessionStorage (survives
 * any framework-level re-imports on navigation).
 */
import { Platform } from 'react-native'

const STORAGE_KEY = 'shogo:pendingImageData'

let pending: string[] | undefined

export function setPendingImageData(data: string[] | undefined) {
  pending = data
  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined' && data) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {}
  }
}

export function consumePendingImageData(): string[] | undefined {
  if (pending) {
    const data = pending
    pending = undefined
    cleanupStorage()
    return data
  }

  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (raw) {
        sessionStorage.removeItem(STORAGE_KEY)
        return JSON.parse(raw) as string[]
      }
    } catch {}
  }

  return undefined
}

function cleanupStorage() {
  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
  }
}
