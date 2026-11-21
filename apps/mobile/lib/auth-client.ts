// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Linking, Platform } from 'react-native'
import { createAuthClient } from '@shogo/shared-app/auth'
import { createAuthClient as createBetterAuthClient } from 'better-auth/react'
import type { BetterFetch } from 'better-auth/react'
import { expoClient, getSetCookie, normalizeCookieName } from '@better-auth/expo/client'
import * as SecureStore from 'expo-secure-store'
import { watchOAuthRedirectCookie, withOAuthRedirectCapture } from './android-oauth-redirect'
import { API_URL } from './api-url'
import { authStoragePrefixFor, getActiveEnvKey } from './env-override'

function normalizeCookieHeader(cookie: string | null | undefined): string | null {
  if (!cookie) return null
  const normalized = cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ')
  return normalized || null
}

/**
 * SecureStore's synchronous calls throw when the keychain cannot be read —
 * after a reboot before first unlock, or while the app wakes in the background
 * (`FunctionCallException: Calling the 'getValueWithKeySync' function has
 * failed`, Sentry SHOGO-IOS-Y). Every request reads the session cookie through
 * this store, so a throw here took down whatever happened to be fetching (an
 * avatar, the notification bell). An unreadable keychain reads as "no cookie"
 * for that one call instead.
 */
export function tolerantSecureStore(store: {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}) {
  return {
    getItem(key: string): string | null {
      try {
        return store.getItem(key)
      } catch (err) {
        console.warn('[auth] SecureStore read failed:', err)
        return null
      }
    },
    setItem(key: string, value: string): void {
      try {
        store.setItem(key, value)
      } catch (err) {
        console.warn('[auth] SecureStore write failed:', err)
      }
    },
  }
}

function createMobileAuthClient() {
  if (Platform.OS === 'web') {
    return createAuthClient({
      baseURL: API_URL!,
      basePath: '/api/auth',
    })
  }

  const storagePrefix = authStoragePrefixFor(getActiveEnvKey())
  const storage = tolerantSecureStore(SecureStore)
  const client = createBetterAuthClient({
    baseURL: API_URL!,
    basePath: '/api/auth',
    plugins: [
      expoClient({
        scheme: 'shogo',
        storagePrefix,
        cookiePrefix: 'shogo',
        storage,
      }),
    ],
  })

  const getCookie = (client as any).getCookie?.bind(client)
  if (getCookie) {
    ;(client as any).getCookie = () => normalizeCookieHeader(getCookie())
  }

  if (Platform.OS === 'android') {
    return withOAuthRedirectCapture(client, () =>
      watchOAuthRedirectCookie({
        linking: Linking,
        storage,
        storagePrefix,
        scheme: 'shogo',
        getSetCookie,
        normalizeCookieName,
      }),
    )
  }
  return client
}

export const authClient = createMobileAuthClient()
const authFetch: BetterFetch = authClient.$fetch

/**
 * Native auto-sign-in must use Better Auth's client fetcher so expoClient can
 * persist the returned session cookies in SecureStore. React Native's global
 * fetch does not maintain a browser-style cookie jar.
 */
export async function autoSignInLocally(): Promise<void> {
  if (Platform.OS === 'web') {
    const response = await fetch(`${API_URL}/api/local/auto-sign-in`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!response.ok) throw new Error(`Auto-sign-in returned ${response.status}`)
    return
  }

  const result = await authFetch<{ ok?: boolean }>(`${API_URL}/api/local/auto-sign-in`, {
    method: 'POST',
  })
  if (result?.error) {
    throw new Error(result.error.message || 'Local auto-sign-in failed')
  }
}
