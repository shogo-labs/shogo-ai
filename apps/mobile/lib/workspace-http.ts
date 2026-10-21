// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The client a *workspace feature* should use (SHO-108).
 *
 * `createHttpClient()` is a bare client: no remote interceptor, so a screen that
 * builds one reads Shogo Cloud even while one of a paired computer's own
 * workspaces is open. The domain client is the interceptor's insert point, and
 * it decides the host once for every call. Resolve it lazily — feature modules
 * build their api at module scope, before the domain provider has mounted.
 */
import type { HttpClient } from '@shogo-ai/sdk'
import { getSDKHttpClient } from '@shogo/shared-app/domain'
import { createHttpClient } from './api'

export function workspaceHttp(): HttpClient {
  return getSDKHttpClient() ?? createHttpClient()
}

/**
 * A client that forwards each call to whichever client exists when the call is
 * made. Inheriting the methods through a proxy keeps every `http.get(...)` call
 * site untouched.
 */
export function workspaceHttpProxy(): HttpClient {
  return new Proxy({} as HttpClient, {
    get(_target, prop) {
      const client = workspaceHttp() as unknown as Record<string | symbol, unknown>
      const value = client[prop]
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}
