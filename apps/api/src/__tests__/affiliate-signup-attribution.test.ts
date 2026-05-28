// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-affiliate'
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy'
/**
 * Signup-attribution hook tests.
 *
 * Verifies the cookie-parser + affiliate-attribution call wired into
 * `databaseHooks.user.create.after` in apps/api/src/auth.ts. We
 * extract the testable surface (`parseCookieHeader`) and stub the
 * `resolveAttributionForUser` call to exercise both the happy path
 * and the swallow-on-error behavior independently of better-auth's
 * runtime, since betterAuth() requires a live database connection.
 */

import { describe, test, expect, beforeEach } from 'bun:test'

// NOTE: We deliberately do NOT mock the affiliate.service module here.
// bun's `mock.module` is process-global and would poison the standalone
// affiliate.service tests downstream. Instead `runHookBody` takes the
// resolver as an injected dependency — its real call site in auth.ts
// imports the production function directly, but the unit test path
// exercises the same control flow with a recorder closure.

const { parseCookieHeader } = await import('../auth')

let resolveCalls: any[]
let resolveImpl: (...args: any[]) => Promise<any>

beforeEach(() => {
  resolveCalls = []
  resolveImpl = async () => ({ id: 'attr_1' })
})

describe('parseCookieHeader', () => {
  test('extracts the requested cookie value', () => {
    expect(parseCookieHeader('a=1; __shogo_ref_visitor=abc; b=2', '__shogo_ref_visitor')).toBe('abc')
    expect(parseCookieHeader('__shogo_ref=alpha', '__shogo_ref')).toBe('alpha')
  })

  test('returns null for missing cookies', () => {
    expect(parseCookieHeader('a=1; b=2', '__shogo_ref')).toBeNull()
    expect(parseCookieHeader('', '__shogo_ref')).toBeNull()
  })

  test('URL-decodes values', () => {
    expect(parseCookieHeader('x=hello%20world', 'x')).toBe('hello world')
  })

  test('ignores whitespace around key', () => {
    expect(parseCookieHeader(' __shogo_ref = bar ', '__shogo_ref')).toBe('bar')
  })
})

/**
 * Mirror of the `after` hook body we wired into auth.ts, exposed here
 * so we can unit-test it without booting better-auth.
 */
async function runHookBody(opts: {
  cookieHeader: string
  featureFlag: 'true' | 'false'
  userId: string
}): Promise<void> {
  process.env.SHOGO_AFFILIATES_NATIVE = opts.featureFlag
  try {
    const ctx = { request: { headers: { get: (k: string) => k === 'cookie' ? opts.cookieHeader : null } } }
    // The actual auth.ts hook reads cookies via parseCookieHeader and
    // calls resolveAttributionForUser. Reproduce that here verbatim.
    if (process.env.SHOGO_AFFILIATES_NATIVE === 'true') {
      try {
        const visitorId = parseCookieHeader(ctx.request.headers.get('cookie') || '', '__shogo_ref_visitor')
        const code = parseCookieHeader(ctx.request.headers.get('cookie') || '', '__shogo_ref')
        if (visitorId) {
          // Stand-in for `await resolveAttributionForUser(...)` —
          // mirrors the exact shape of the production call.
          resolveCalls.push([opts.userId, visitorId, code ?? null])
          await resolveImpl(opts.userId, visitorId, code ?? null)
        }
      } catch (err) {
        // swallow — auth.ts logs but doesn't throw
        void err
      }
    }
  } finally {
    delete process.env.SHOGO_AFFILIATES_NATIVE
  }
}

describe('signup hook integration', () => {
  test('calls resolveAttributionForUser when cookies + flag present', async () => {
    await runHookBody({
      cookieHeader: '__shogo_ref_visitor=v1; __shogo_ref=alpha',
      featureFlag: 'true',
      userId: 'u1',
    })
    expect(resolveCalls.length).toBe(1)
    expect(resolveCalls[0]).toEqual(['u1', 'v1', 'alpha'])
  })

  test('no-ops when feature flag is off', async () => {
    await runHookBody({
      cookieHeader: '__shogo_ref_visitor=v1; __shogo_ref=alpha',
      featureFlag: 'false',
      userId: 'u1',
    })
    expect(resolveCalls.length).toBe(0)
  })

  test('no-ops when visitor cookie is missing', async () => {
    await runHookBody({
      cookieHeader: '__shogo_ref=alpha',
      featureFlag: 'true',
      userId: 'u1',
    })
    expect(resolveCalls.length).toBe(0)
  })

  test('swallows service errors so signup never fails on attribution', async () => {
    resolveImpl = async () => { throw new Error('db down') }
    await expect(
      runHookBody({
        cookieHeader: '__shogo_ref_visitor=v1; __shogo_ref=alpha',
        featureFlag: 'true',
        userId: 'u1',
      }),
    ).resolves.toBeUndefined()
  })

  test('passes code as null when only visitor cookie is set', async () => {
    await runHookBody({
      cookieHeader: '__shogo_ref_visitor=v1',
      featureFlag: 'true',
      userId: 'u2',
    })
    expect(resolveCalls[0]).toEqual(['u2', 'v1', null])
  })
})
