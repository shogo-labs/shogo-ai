// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Context } from 'hono'
import { resolveApiKey } from '../routes/api-keys'

export type ResolvedApiKey = NonNullable<Awaited<ReturnType<typeof resolveApiKey>>>

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * The `shogo_sk_*` key `authMiddleware` already resolved for this request,
     * so route-level auth doesn't look it up (and touch it) a second time.
     */
    apiKeyResolution?: { key: string; result: ResolvedApiKey | null }
  }
}

/**
 * `resolveApiKey` for a request that went through `authMiddleware`: reuses the
 * middleware's result when it resolved this same key. App tokens are never
 * reused (the middleware resolves without `allowAppTokens`).
 */
export async function resolveApiKeyForRequest(
  c: Context,
  key: string,
  opts?: Parameters<typeof resolveApiKey>[1],
): Promise<ResolvedApiKey | null> {
  const memo = c.get('apiKeyResolution')
  if (memo && memo.key === key && !opts?.allowAppTokens) return memo.result
  return resolveApiKey(key, opts)
}
