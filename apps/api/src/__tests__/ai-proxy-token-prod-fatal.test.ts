// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Coverage-gap closer for src/lib/ai-proxy-token.ts.
 *
 * The existing ai-proxy-token.test.ts covers happy-path token mint +
 * verify, but never exercises the production FATAL branch in
 * getSigningSecret() (line 44-46 in the merged report): when
 * NODE_ENV='production' AND none of AI_PROXY_SECRET /
 * BETTER_AUTH_SECRET / PREVIEW_TOKEN_SECRET is configured, the function
 * must throw rather than fall back to the dev-only secret.
 *
 * This is the most important branch in the file: a misconfigured
 * production deploy must crash loud, never silently sign with a
 * publicly-known string. Pinning it via tests prevents the regression.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const ENV_KEYS = [
  'AI_PROXY_SECRET',
  'BETTER_AUTH_SECRET',
  'PREVIEW_TOKEN_SECRET',
  'NODE_ENV',
] as const

const snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) snapshot[k] = process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
})

// We import the module dynamically inside each test because getSigningSecret
// is called lazily inside generateProxyToken / verifyProxyToken — meaning
// the env state at the *call site* determines the secret, not the import
// site. A single import suffices.
const { generateProxyToken, verifyProxyToken } = await import('../lib/ai-proxy-token')

describe('getSigningSecret — production FATAL branch (lines 43-47)', () => {
  test('generateProxyToken throws in production when no signing secret is configured', async () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'production'

    await expect(
      generateProxyToken('proj_x', 'ws_x')
    ).rejects.toThrow(/FATAL: No signing secret configured in production/)
  })

  test('production error message points operators at the three env vars they can set', async () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'production'

    try {
      await generateProxyToken('proj_x', 'ws_x')
      throw new Error('expected production FATAL throw')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('AI_PROXY_SECRET')
      expect(msg).toContain('BETTER_AUTH_SECRET')
      expect(msg).toContain('PREVIEW_TOKEN_SECRET')
    }
  })

  test('verifyProxyToken returns null in production with no secret (FATAL is caught by its outer try/catch)', async () => {
    // verifyProxyToken wraps the whole flow in `try { ... } catch { return null }`,
    // so the FATAL throw from getProxySecret surfaces as a verification
    // failure rather than an uncaught exception. Pin the observable
    // contract: a misconfigured prod sees null verifications, not crashes
    // mid-request.
    process.env.AI_PROXY_SECRET = 'test-secret-for-mint'
    process.env.NODE_ENV = 'development'
    const token = await generateProxyToken('proj_x', 'ws_x')

    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'production'

    expect(await verifyProxyToken(token)).toBeNull()
  })

  test('production with AI_PROXY_SECRET set succeeds (the FATAL is conditional, not blanket)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.AI_PROXY_SECRET = 'prod-secret-do-not-use'
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    const token = await generateProxyToken('proj_p', 'ws_p')
    expect(token.split('.')).toHaveLength(3)
    const verified = await verifyProxyToken(token)
    expect(verified?.projectId).toBe('proj_p')
  })

  test('production with BETTER_AUTH_SECRET only (no AI_PROXY_SECRET) also succeeds', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    process.env.BETTER_AUTH_SECRET = 'fallback-1'
    delete process.env.PREVIEW_TOKEN_SECRET

    const token = await generateProxyToken('p', 'w')
    expect(await verifyProxyToken(token)).not.toBeNull()
  })

  test('production with PREVIEW_TOKEN_SECRET only also succeeds (last fallback in the chain)', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    process.env.PREVIEW_TOKEN_SECRET = 'fallback-2'

    const token = await generateProxyToken('p', 'w')
    expect(await verifyProxyToken(token)).not.toBeNull()
  })

  test('non-production with no secrets falls back to the dev-only literal (warning logged, no throw)', async () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'development'

    // Must NOT throw — dev fallback is allowed.
    const token = await generateProxyToken('p', 'w')
    expect(token.split('.')).toHaveLength(3)
  })

  test('NODE_ENV unset (=== "production" is false) takes the dev fallback', async () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    delete process.env.NODE_ENV

    const token = await generateProxyToken('p', 'w')
    expect(token.split('.')).toHaveLength(3)
  })
})
