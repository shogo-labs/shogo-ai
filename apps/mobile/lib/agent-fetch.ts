// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { fetchWithWakeRetry, isWakeRetryable } from './agent-retry'
import { authedFetchInit } from './authed-fetch-init'

export { authedCredentials, authedFetchInit, nativeAuthHeaders } from './authed-fetch-init'

/**
 * Wraps `fetch` with the correct auth credentials for agent-proxy requests.
 *
 * On web: adds `credentials: 'include'` so the browser sends session cookies
 * cross-origin (web app :8081 -> API :8002).
 *
 * On native: reads the session cookie from Expo SecureStore via Better Auth's
 * `getCookie()` and passes it as a `Cookie` header with `credentials: 'omit'`
 * (native `fetch` doesn't send cookies automatically, and `'include'` would
 * let the platform's cookie jar corrupt the header — see `authedFetchInit`).
 *
 * A GET or HEAD that arrives while a hosted workspace's desktop is still waking
 * is retried once the host says it is up (SHO-538) — this is the one place every
 * agent-proxy loader goes through, so no caller has to know about the wake.
 */
export function agentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const send = () => fetch(input, authedFetchInit(init))

  return isWakeRetryable(init?.method) ? fetchWithWakeRetry(send) : send()
}
