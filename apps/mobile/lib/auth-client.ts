// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { createAuthClient } from '@shogo/shared-app/auth'
import { createAuthClient as createBetterAuthClient } from 'better-auth/react'
import type { BetterFetch } from 'better-auth/react'
import { expoClient } from '@better-auth/expo/client'
import * as SecureStore from 'expo-secure-store'
import { API_URL } from './api-url'

function normalizeCookieHeader(cookie: string | null | undefined): string | null {
  if (!cookie) return null
  const normalized = cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ')
  return normalized || null
}

function createMobileAuthClient() {
  if (Platform.OS === 'web') {
    return createAuthClient({
      baseURL: API_URL!,
      basePath: '/api/auth',
    })
  }

  const client = createBetterAuthClient({
    baseURL: API_URL!,
    basePath: '/api/auth',
    plugins: [
      expoClient({
        scheme: 'shogo',
        storagePrefix: 'shogo',
        cookiePrefix: 'shogo',
        storage: SecureStore,
      }),
    ],
  })

  const getCookie = (client as any).getCookie?.bind(client)
  if (getCookie) {
    ;(client as any).getCookie = () => normalizeCookieHeader(getCookie())
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
