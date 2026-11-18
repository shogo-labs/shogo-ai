// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cluster-wide signup limits (SHO-416).
 *
 * The point of these tests is the property the incident exposed: the counter
 * must be shared, not per process, and it must key on the IP *prefix* so a
 * farm rotating addresses inside one IPv6 /64 still hits one bucket. A fake
 * Redis stands in for the shared client, so two calls through the limiter are
 * two pods sharing one counter.
 */

import { afterAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { _setChatLimitsRedisForTests } from '../chat-limits'
import {
  checkSignupRateLimit,
  checkVerificationEmailRateLimit,
  SIGNUP_RATE_LIMITS,
} from '../signup-rate-limit'

/** Just enough of Redis for `takeRateLimit`'s INCR + PEXPIRE script. */
function fakeRedis() {
  const counters = new Map<string, number>()
  return {
    counters,
    async eval(_script: string, _n: number, key: string) {
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      return n
    },
    async zrem() {
      return 1
    },
  }
}

const BASE = new Date('2026-11-18T12:00:00Z')
const v4 = (ip: string) => ({ 'cf-connecting-ip': ip })

beforeEach(() => {
  setSystemTime(BASE)
  _setChatLimitsRedisForTests(fakeRedis())
  process.env.NODE_ENV = 'production'
  process.env.SHOGO_LOCAL_MODE = 'false'
  delete process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  delete process.env.SHOGO_E2E_BOOTSTRAP_ENABLED
})

afterAll(() => {
  setSystemTime()
  _setChatLimitsRedisForTests(undefined)
})

describe('burst limit', () => {
  test('the 4th signup in 10s from one prefix is refused, with a Retry-After', async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      expect((await checkSignupRateLimit(v4('203.0.113.9'))).allowed).toBe(true)
    }
    const refused = await checkSignupRateLimit(v4('203.0.113.9'))
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(10)
  })

  test('a different prefix has its own bucket', async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      await checkSignupRateLimit(v4('203.0.113.9'))
    }
    expect((await checkSignupRateLimit(v4('198.51.100.4'))).allowed).toBe(true)
  })

  test('the window rolls: the next 10s bucket starts clean', async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      await checkSignupRateLimit(v4('203.0.113.9'))
    }
    expect((await checkSignupRateLimit(v4('203.0.113.9'))).allowed).toBe(false)
    setSystemTime(new Date(BASE.getTime() + 10_000))
    expect((await checkSignupRateLimit(v4('203.0.113.9'))).allowed).toBe(true)
  })
})

describe('IPv6 /64 keying', () => {
  test('two addresses in one /64 share a bucket', async () => {
    const a = { 'cf-connecting-ip': '2606:54c1:1:2::1' }
    const b = { 'cf-connecting-ip': '2606:54c1:1:2::2' }
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      expect((await checkSignupRateLimit(a)).allowed).toBe(true)
    }
    // A different address, same /64 — this is the WARP wave from the incident.
    expect((await checkSignupRateLimit(b)).allowed).toBe(false)
  })

  test('a different /64 is a different bucket', async () => {
    const a = { 'cf-connecting-ip': '2606:54c1:1:2::1' }
    const other = { 'cf-connecting-ip': '2606:54c1:1:3::1' }
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      await checkSignupRateLimit(a)
    }
    expect((await checkSignupRateLimit(other)).allowed).toBe(true)
  })
})

describe('daily cap', () => {
  test('the 21st signup in a day from one prefix is refused', async () => {
    const headers = v4('178.83.181.248')
    // Step past the burst window each time so only the daily cap can refuse.
    for (let i = 0; i < SIGNUP_RATE_LIMITS.daily.max; i++) {
      setSystemTime(new Date(BASE.getTime() + i * 11_000))
      expect((await checkSignupRateLimit(headers)).allowed).toBe(true)
    }
    setSystemTime(new Date(BASE.getTime() + SIGNUP_RATE_LIMITS.daily.max * 11_000))
    const refused = await checkSignupRateLimit(headers)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })
})

describe('bypasses', () => {
  test('the load-test key skips the limiter', async () => {
    process.env.LOAD_TEST_SECRET = 'load-secret'
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      await checkSignupRateLimit(v4('203.0.113.9'))
    }
    expect((await checkSignupRateLimit(v4('203.0.113.9'), { bypass: true })).allowed).toBe(true)
    delete process.env.LOAD_TEST_SECRET
  })

  test('the e2e bootstrap header skips the limiter', async () => {
    process.env.SHOGO_E2E_BOOTSTRAP_SECRET = 'e2e-secret'
    process.env.SHOGO_E2E_BOOTSTRAP_ENABLED = '1'
    const headers = { 'cf-connecting-ip': '203.0.113.9', 'x-e2e-bootstrap-secret': 'e2e-secret' }
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max + 2; i++) {
      expect((await checkSignupRateLimit(headers)).allowed).toBe(true)
    }
  })

  test('a request with no resolvable IP is allowed (local and test traffic)', async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max + 2; i++) {
      expect((await checkSignupRateLimit({})).allowed).toBe(true)
    }
  })

  test('outside production the limiter is off, matching rateLimit.enabled', async () => {
    process.env.NODE_ENV = 'development'
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max + 2; i++) {
      expect((await checkSignupRateLimit(v4('203.0.113.9'))).allowed).toBe(true)
    }
  })
})

describe('memory fallback', () => {
  test('with no Redis the limit still applies, per process', async () => {
    _setChatLimitsRedisForTests(null)
    for (let i = 0; i < SIGNUP_RATE_LIMITS.burst.max; i++) {
      expect((await checkSignupRateLimit(v4('203.0.113.9'))).allowed).toBe(true)
    }
    expect((await checkSignupRateLimit(v4('203.0.113.9'))).allowed).toBe(false)
  })
})

describe('verification-email resends', () => {
  test('the 4th resend for one address in an hour is refused', async () => {
    const headers = v4('203.0.113.9')
    for (let i = 0; i < SIGNUP_RATE_LIMITS.verificationEmail.max; i++) {
      expect((await checkVerificationEmailRateLimit(headers, 'bot@farm.dev')).allowed).toBe(true)
    }
    const refused = await checkVerificationEmailRateLimit(headers, 'bot@farm.dev')
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  test('the address is matched case-insensitively', async () => {
    const headers = v4('203.0.113.9')
    for (let i = 0; i < SIGNUP_RATE_LIMITS.verificationEmail.max; i++) {
      await checkVerificationEmailRateLimit(headers, 'Bot@Farm.dev')
    }
    expect((await checkVerificationEmailRateLimit(headers, 'bot@farm.dev')).allowed).toBe(false)
  })

  test('a different address from the same prefix is unaffected', async () => {
    const headers = v4('203.0.113.9')
    for (let i = 0; i < SIGNUP_RATE_LIMITS.verificationEmail.max; i++) {
      await checkVerificationEmailRateLimit(headers, 'bot@farm.dev')
    }
    expect((await checkVerificationEmailRateLimit(headers, 'real@company.io')).allowed).toBe(true)
  })

  test('resends also count against the per-prefix daily cap', async () => {
    const headers = v4('178.83.181.248')
    // Burn the daily signup budget from this prefix.
    for (let i = 0; i < SIGNUP_RATE_LIMITS.daily.max; i++) {
      setSystemTime(new Date(BASE.getTime() + i * 11_000))
      await checkSignupRateLimit(headers)
    }
    setSystemTime(new Date(BASE.getTime() + SIGNUP_RATE_LIMITS.daily.max * 11_000))
    expect((await checkVerificationEmailRateLimit(headers, 'fresh@farm.dev')).allowed).toBe(false)
  })
})
