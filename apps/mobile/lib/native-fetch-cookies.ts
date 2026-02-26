/**
 * Patches global fetch on native platforms to automatically attach
 * auth cookies to requests going to our API server.
 *
 * This works around React Native Android's restrictions on manually
 * setting Cookie headers. By intercepting at the global fetch level,
 * cookies are injected before RN's networking layer processes the request.
 *
 * Call `patchFetchWithCookies()` once at app startup (after initAuthStorage).
 */

import { Platform } from 'react-native'
import { getAuthCookieHeader, saveSetCookieHeader } from './auth-storage'
import { API_URL } from './api'

let patched = false

export function patchFetchWithCookies(): void {
  if (Platform.OS === 'web' || patched) return
  patched = true

  const apiHost = API_URL!
  const originalFetch = global.fetch

  global.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const isApiRequest = url.startsWith(apiHost)

    if (isApiRequest) {
      const cookie = getAuthCookieHeader()
      if (cookie) {
        const headers = new Headers(init?.headers)
        if (!headers.has('cookie') && !headers.has('Cookie')) {
          headers.set('cookie', cookie)
        }
        init = { ...init, headers }
      }
    }

    const response = await originalFetch(input, init as any)

    if (isApiRequest) {
      const setCookie = response.headers.get('set-cookie') || response.headers.get('Set-Cookie')
      if (setCookie) {
        saveSetCookieHeader(setCookie)
      }
    }

    return response
  } as typeof fetch
}
