// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ActiveInstance Context — Mobile adapter
 *
 * Thin wrapper around the shared `ActiveInstanceProvider` from
 * `@shogo/shared-app/hooks`. Provides mobile-specific storage (AsyncStorage)
 * and auth (cookie injection for native).
 *
 * Re-exports the shared types and hook so existing imports continue to work.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  ActiveInstanceProvider as SharedProvider,
  useActiveInstance,
  localStorageAdapter,
  type ActiveInstance,
  type ActiveInstanceContextValue,
  type InstanceStorageAdapter,
} from '@shogo/shared-app/hooks'
import { API_URL } from '../lib/api'
import { authClient } from '../lib/auth-client'

// ─── Storage adapters ───────────────────────────────────────────────────────

const asyncStorageAdapter: InstanceStorageAdapter = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
}

function getStorage(): InstanceStorageAdapter {
  return Platform.OS === 'web' ? localStorageAdapter : asyncStorageAdapter
}

// ─── Fetch options for auth ─────────────────────────────────────────────────

function useFetchOptions(): RequestInit {
  return useMemo(() => {
    if (Platform.OS === 'web') {
      return { credentials: 'include' as const }
    }
    const cookie = (authClient as any).getCookie?.()
    return cookie ? { headers: { Cookie: cookie } } : {}
  }, [])
}

// ─── Mobile Provider ────────────────────────────────────────────────────────

export function ActiveInstanceProvider({ children }: { children: ReactNode }) {
  const storage = useMemo(() => getStorage(), [])
  const fetchOptions = useFetchOptions()

  return (
    <SharedProvider
      apiUrl={API_URL ?? ''}
      storage={storage}
      fetchOptions={fetchOptions}
    >
      {children}
    </SharedProvider>
  )
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { useActiveInstance }
export type { ActiveInstance, ActiveInstanceContextValue }
