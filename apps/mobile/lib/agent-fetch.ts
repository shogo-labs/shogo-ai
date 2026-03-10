// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { authClient } from './auth-client'

/**
 * Wraps `fetch` with the correct auth credentials for agent-proxy requests.
 *
 * On web: adds `credentials: 'include'` so the browser sends session cookies
 * cross-origin (web app :8081 -> API :8002).
 *
 * On native: reads the session cookie from Expo SecureStore via Better Auth's
 * `getCookie()` and passes it as a `Cookie` header (native `fetch` doesn't
 * send cookies automatically).
 */
export async function agentFetch(url: string, init?: RequestInit): Promise<Response> {
  const isWeb = Platform.OS === 'web'
  const extraHeaders: Record<string, string> = {}

  if (!isWeb) {
    const cookie = (authClient as any).getCookie?.()
    console.log(`[agentFetch] native cookie present: ${!!cookie}, length: ${cookie?.length ?? 0}`)
    if (cookie) extraHeaders['Cookie'] = cookie
  }

  const method = init?.method ?? 'GET'
  console.log(`[agentFetch] ${method} ${url} (credentials: ${isWeb ? 'include' : 'omit'}, hasCookie: ${!!extraHeaders['Cookie']})`)

  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...extraHeaders, ...(init?.headers as Record<string, string>) },
      credentials: isWeb ? 'include' : 'omit',
    })
    console.log(`[agentFetch] ${method} ${url} → ${res.status} ${res.statusText}`)
    return res
  } catch (err) {
    console.error(`[agentFetch] ${method} ${url} → NETWORK ERROR:`, err)
    throw err
  }
}
