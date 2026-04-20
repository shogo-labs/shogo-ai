// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-platform authed EventSource factory.
 *
 * On web: uses `withCredentials: true` so the browser forwards session cookies.
 * On native: passes the Better-Auth session cookie via a `Cookie` header
 * (our polyfill in apps/mobile/polyfills.ts supports custom headers).
 */
import { Platform } from 'react-native'
import { authClient } from './auth-client'

export function createAuthedEventSource(url: string): EventSource {
  const isWeb = Platform.OS === 'web'
  if (isWeb) {
    return new EventSource(url, { withCredentials: true })
  }
  const cookie = (authClient as any).getCookie?.()
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  return new (EventSource as any)(url, { headers })
}
