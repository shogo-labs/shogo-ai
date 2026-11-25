// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How an authenticated API request carries its credential on each platform
 * (SHO-564).
 *
 * Kept apart from `agent-fetch.ts` because that module is replaced wholesale by
 * the unit-test preload (so a test can install a handler for every API call),
 * and these builders are exactly what the tests need to assert against.
 */
import { Platform } from 'react-native'
import { authClient } from './auth-client'

/**
 * The headers a native request to an authenticated URL needs, for a caller that
 * cannot use `fetch` — a download streamed to disk by `expo-file-system`, which
 * takes headers but no request init. Web needs none: the browser sends the
 * session cookie itself.
 */
export function nativeAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

/**
 * The `credentials` mode an authenticated API request needs on this platform.
 *
 * Use it where only the mode can be passed (the turn probe takes a
 * `credentials` option rather than a whole init). Anything that builds a
 * `fetch` init should use `authedFetchInit` instead, so the native `Cookie`
 * header comes along too.
 */
export function authedCredentials(): RequestCredentials {
  return Platform.OS === 'web' ? 'include' : 'omit'
}

/**
 * A `fetch` init for an authenticated API request, with the platform's auth
 * carried the way that platform needs it.
 *
 * On web: `credentials: 'include'` so the browser sends the session cookie
 * cross-origin (web app :8081 -> API :8002).
 *
 * On native: the session cookie from Expo SecureStore (via Better Auth's
 * `getCookie()`) as a `Cookie` header, **and** `credentials: 'omit'`.
 *
 * The `'omit'` is not cosmetic. `expo/fetch` turns an *undefined* credentials
 * into `'include'` (node_modules/expo/src/winter/fetch/fetch.ts), and on iOS
 * `'include'` makes NSURLSession copy the shared `HTTPCookieStorage` jar into
 * the request and then `addValue` our `Cookie` on top. Whenever the jar holds
 * anything for the API host the request carries a stale or duplicated cookie
 * and better-auth answers 401 — the "reopen a chat and the live reply never
 * comes back" bug (no rejoin probe, no Stop, no task list, no `/api/machines`).
 */
export function authedFetchInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...nativeAuthHeaders(),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    credentials: authedCredentials(),
  }
}
