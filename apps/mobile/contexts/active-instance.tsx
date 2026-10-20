// SPDX-License-Identifier: MIT
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

import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  ActiveInstanceProvider as SharedProvider,
  useActiveInstance as useSharedActiveInstance,
  localStorageAdapter,
  type ActiveInstance,
  type ActiveInstanceContextValue,
  type InstanceStorageAdapter,
} from '@shogo/shared-app/hooks'
// `api-url`, not `../lib/api`: the latter re-exports the whole non-domain API
// surface and imports `auth-client`, whose better-auth client fetches its config
// at module load. Only the URL is needed here.
import { API_URL } from '../lib/api-url'

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

/**
 * The native auth cookie, loaded on first use.
 *
 * `lib/auth-client` builds a better-auth client at module load, and that client
 * fetches its own config from the API origin. In the app that is one request
 * after boot; in a happy-dom unit test (any suite that renders the sidebar
 * touches this module) there is no origin to reach and the import throws.
 * Web never needs it: the cookie travels as `credentials: 'include'`.
 */
function nativeAuthCookie(): string | null {
  const { authClient } = require('../lib/auth-client') as typeof import('../lib/auth-client')
  return (authClient as { getCookie?: () => string | null }).getCookie?.() ?? null
}

function useFetchOptions(): RequestInit {
  return useMemo(() => {
    if (Platform.OS === 'web') {
      return { credentials: 'include' as const }
    }
    const cookie = nativeAuthCookie()
    return cookie ? { headers: { Cookie: cookie } } : {}
  }, [])
}

// ─── Mobile Provider ────────────────────────────────────────────────────────

/**
 * The value every app component reads, created with *this* app's React.
 *
 * `@shogo/shared-app` resolves its own copy of React, so a `useContext` call
 * made inside the shared package runs against a different dispatcher than the
 * one rendering the tree — harmless in the app bundle, fatal in any unit test
 * that renders a component through this context ("Invalid hook call … more
 * than one copy of React"). The adapter therefore re-publishes the shared
 * provider's value into a context created here.
 */
const MobileActiveInstanceContext = createContext<ActiveInstanceContextValue>({
  instance: null,
  remoteAgentBaseUrl: null,
  instanceStatus: 'unknown',
  setInstance: () => {},
  clearInstance: () => {},
})

function MirrorSharedInstance({ children }: { children: ReactNode }) {
  const value = useSharedActiveInstance()
  return (
    <MobileActiveInstanceContext.Provider value={value}>{children}</MobileActiveInstanceContext.Provider>
  )
}

export function ActiveInstanceProvider({ children }: { children: ReactNode }) {
  const storage = useMemo(() => getStorage(), [])
  const fetchOptions = useFetchOptions()

  return (
    <SharedProvider
      apiUrl={API_URL ?? ''}
      storage={storage}
      fetchOptions={fetchOptions}
    >
      <MirrorSharedInstance>{children}</MirrorSharedInstance>
    </SharedProvider>
  )
}

export function useActiveInstance(): ActiveInstanceContextValue {
  return useContext(MobileActiveInstanceContext)
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type { ActiveInstance, ActiveInstanceContextValue }
