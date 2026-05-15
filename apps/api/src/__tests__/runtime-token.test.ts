// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/runtime-token.ts — per-project bearer token
 * derivation + verification. Pure crypto (HMAC-SHA256), no I/O, so
 * every branch is unit-testable. We exercise:
 *
 *  - Signing-secret resolution (AI_PROXY_SECRET, BETTER_AUTH_SECRET,
 *    PREVIEW_TOKEN_SECRET, dev-default, prod tripwire)
 *  - deriveRuntimeToken: v1 format, determinism, projectId scoping,
 *    empty-projectId guard
 *  - deriveWebhookToken: bare hex, distinct from runtime token
 *  - parseRuntimeToken: v1 / legacy / malformed classification, edge
 *    cases (empty, short, bad separator, non-hex hmac, embedded
 *    projectId with underscores)
 *  - verifyRuntimeToken: every VerifyResult reason, cross-project
 *    rejection, legacy fallback, timing-safe-compare behaviour
 */

import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  RUNTIME_TOKEN_V1_PREFIX,
  deriveRuntimeToken,
  deriveWebhookToken,
  parseRuntimeToken,
  verifyRuntimeToken,
} from '../lib/runtime-token'

// ─── env scaffolding ───────────────────────────────────────────────────────

const ENV_KEYS = [
  'AI_PROXY_SECRET',
  'BETTER_AUTH_SECRET',
  'PREVIEW_TOKEN_SECRET',
  'NODE_ENV',
] as const

const SAVED: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
  process.env.AI_PROXY_SECRET = 'unit-test-signing-secret'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

function hmacFor(projectId: string, secret = process.env.AI_PROXY_SECRET!): string {
  return createHmac('sha256', secret).update(`runtime-auth:${projectId}`).digest('hex')
}

// ─── deriveRuntimeToken ───────────────────────────────────────────────────

describe('deriveRuntimeToken', () => {
  test('emits the v1 format: rt_v1_<projectId>_<64-hex-hmac>', () => {
    const t = deriveRuntimeToken('proj-1')
    expect(t.startsWith(RUNTIME_TOKEN_V1_PREFIX)).toBe(true)
    expect(t).toMatch(/^rt_v1_proj-1_[0-9a-f]{64}$/)
  })

  test('exported prefix constant matches the literal "rt_v1_"', () => {
    expect(RUNTIME_TOKEN_V1_PREFIX).toBe('rt_v1_')
  })

  test('embedded projectId is exactly the input (no encoding)', () => {
    const t = deriveRuntimeToken('Project-WithCAPS-123')
    expect(t).toContain('_Project-WithCAPS-123_')
  })

  test('hmac portion equals HMAC-SHA256(secret, "runtime-auth:" + projectId)', () => {
    const t = deriveRuntimeToken('proj-1')
    const expected = hmacFor('proj-1')
    expect(t.endsWith('_' + expected)).toBe(true)
  })

  test('deterministic — same projectId + secret → identical token', () => {
    expect(deriveRuntimeToken('proj-1')).toBe(deriveRuntimeToken('proj-1'))
  })

  test('different projectIds → different tokens (and different HMACs)', () => {
    const a = deriveRuntimeToken('proj-A')
    const b = deriveRuntimeToken('proj-B')
    expect(a).not.toBe(b)
    expect(a.slice(-64)).not.toBe(b.slice(-64))
  })

  test('different signing secrets → different HMACs for same projectId', () => {
    const t1 = deriveRuntimeToken('proj-1')
    process.env.AI_PROXY_SECRET = 'a-completely-different-secret'
    const t2 = deriveRuntimeToken('proj-1')
    expect(t1.slice(-64)).not.toBe(t2.slice(-64))
  })

  test('empty projectId throws', () => {
    expect(() => deriveRuntimeToken('')).toThrow(/projectId is required/)
  })
})

// ─── signing-secret resolution priority ───────────────────────────────────

describe('signing secret resolution', () => {
  test('AI_PROXY_SECRET wins over BETTER_AUTH_SECRET', () => {
    process.env.AI_PROXY_SECRET = 'A'
    process.env.BETTER_AUTH_SECRET = 'B'
    const usingA = deriveRuntimeToken('p').slice(-64)
    delete process.env.AI_PROXY_SECRET
    const usingB = deriveRuntimeToken('p').slice(-64)
    expect(usingA).not.toBe(usingB)
    expect(usingA).toBe(hmacFor('p', 'A'))
    expect(usingB).toBe(hmacFor('p', 'B'))
  })

  test('BETTER_AUTH_SECRET wins over PREVIEW_TOKEN_SECRET', () => {
    delete process.env.AI_PROXY_SECRET
    process.env.BETTER_AUTH_SECRET = 'B'
    process.env.PREVIEW_TOKEN_SECRET = 'P'
    expect(deriveRuntimeToken('p').slice(-64)).toBe(hmacFor('p', 'B'))
  })

  test('falls back to PREVIEW_TOKEN_SECRET when both others missing', () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    process.env.PREVIEW_TOKEN_SECRET = 'P'
    expect(deriveRuntimeToken('p').slice(-64)).toBe(hmacFor('p', 'P'))
  })

  test('non-production with no secret → uses dev-only default (does not throw)', () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'test'
    expect(() => deriveRuntimeToken('p')).not.toThrow()
    expect(deriveRuntimeToken('p').slice(-64)).toBe(
      hmacFor('p', 'shogo-dev-only-runtime-token-secret'),
    )
  })

  test('NODE_ENV=production with no secret → throws the tripwire error', () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'production'
    expect(() => deriveRuntimeToken('p')).toThrow(
      /No signing secret configured/,
    )
  })
})

// ─── deriveWebhookToken ───────────────────────────────────────────────────

describe('deriveWebhookToken', () => {
  test('emits bare 64-char hex (no v1 prefix, no underscores)', () => {
    const t = deriveWebhookToken('proj-1')
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(t.startsWith(RUNTIME_TOKEN_V1_PREFIX)).toBe(false)
  })

  test('uses "webhook:" namespace so it CANNOT equal the runtime hmac', () => {
    const webhook = deriveWebhookToken('proj-1')
    const runtimeHmac = deriveRuntimeToken('proj-1').slice(-64)
    expect(webhook).not.toBe(runtimeHmac)
  })

  test('deterministic for same projectId + secret', () => {
    expect(deriveWebhookToken('proj-X')).toBe(deriveWebhookToken('proj-X'))
  })

  test('different projectIds → different webhook tokens', () => {
    expect(deriveWebhookToken('a')).not.toBe(deriveWebhookToken('b'))
  })
})

// ─── parseRuntimeToken ────────────────────────────────────────────────────

describe('parseRuntimeToken', () => {
  test('returns null for empty string', () => {
    expect(parseRuntimeToken('')).toBeNull()
  })

  test('returns { format: "legacy", hmac } for bare 64-char hex', () => {
    const hex = 'a'.repeat(64)
    expect(parseRuntimeToken(hex)).toEqual({ format: 'legacy', hmac: hex })
  })

  test('legacy: 63 hex chars is rejected (length-strict)', () => {
    expect(parseRuntimeToken('a'.repeat(63))).toBeNull()
  })

  test('legacy: 65 hex chars is rejected', () => {
    expect(parseRuntimeToken('a'.repeat(65))).toBeNull()
  })

  test('legacy: uppercase hex is rejected (lowercase only)', () => {
    expect(parseRuntimeToken('A'.repeat(64))).toBeNull()
  })

  test('returns { format: "v1", projectId, hmac } for a well-formed v1 token', () => {
    const hmac = 'b'.repeat(64)
    const t = `rt_v1_proj-7_${hmac}`
    expect(parseRuntimeToken(t)).toEqual({ format: 'v1', projectId: 'proj-7', hmac })
  })

  test('v1: projectId may itself contain underscores — only the last "_" is the separator', () => {
    const hmac = 'c'.repeat(64)
    const t = `rt_v1_team_alpha_proj_42_${hmac}`
    const parsed = parseRuntimeToken(t)
    expect(parsed).toEqual({
      format: 'v1',
      projectId: 'team_alpha_proj_42',
      hmac,
    })
  })

  test('v1: empty projectId between prefix and hmac → null', () => {
    expect(parseRuntimeToken(`rt_v1__${'d'.repeat(64)}`)).toBeNull()
  })

  test('v1: too short (no projectId at all) → null', () => {
    expect(parseRuntimeToken(`rt_v1_${'d'.repeat(64)}`)).toBeNull()
  })

  test('v1: hmac portion containing non-hex char → null', () => {
    const hmac = 'g' + 'a'.repeat(63) // 'g' not in [0-9a-f]
    expect(parseRuntimeToken(`rt_v1_p_${hmac}`)).toBeNull()
  })

  test('v1: missing "_" separator before the hmac → null', () => {
    const hmac = 'a'.repeat(64)
    expect(parseRuntimeToken(`rt_v1_proj${hmac}`)).toBeNull() // no '_' before hmac
  })

  test('non-runtime tokens (api keys, cookies, jwt-ish) → null', () => {
    expect(parseRuntimeToken('shogo_sk_abcdef1234567890')).toBeNull()
    expect(parseRuntimeToken('session=cookie-value')).toBeNull()
    expect(parseRuntimeToken('eyJhbGciOi.foo.bar')).toBeNull()
    expect(parseRuntimeToken('not-a-token')).toBeNull()
  })
})

// ─── verifyRuntimeToken ──────────────────────────────────────────────────

describe('verifyRuntimeToken — happy paths', () => {
  test('v1 token verifies and recovers projectId from the bearer alone', () => {
    const t = deriveRuntimeToken('proj-7')
    expect(verifyRuntimeToken(t)).toEqual({
      ok: true,
      projectId: 'proj-7',
      format: 'v1',
    })
  })

  test('v1 verification IGNORES fallbackProjectId entirely', () => {
    const t = deriveRuntimeToken('proj-actual')
    // Even a wildly wrong fallback is ignored — v1 is self-scoping.
    expect(verifyRuntimeToken(t, 'proj-WRONG')).toEqual({
      ok: true,
      projectId: 'proj-actual',
      format: 'v1',
    })
  })

  test('legacy bare-hex token verifies when matching fallbackProjectId is supplied', () => {
    const legacyHmac = hmacFor('proj-legacy')
    expect(verifyRuntimeToken(legacyHmac, 'proj-legacy')).toEqual({
      ok: true,
      projectId: 'proj-legacy',
      format: 'legacy',
    })
  })
})

describe('verifyRuntimeToken — rejection paths', () => {
  test('null/undefined/empty → malformed', () => {
    expect(verifyRuntimeToken(null).ok).toBe(false)
    expect(verifyRuntimeToken(undefined).ok).toBe(false)
    expect(verifyRuntimeToken('').ok).toBe(false)
    if (!verifyRuntimeToken(null).ok) expect(verifyRuntimeToken(null).reason).toBe('malformed')
  })

  test('structurally invalid (not v1, not bare hex) → malformed', () => {
    const r = verifyRuntimeToken('not-a-token-at-all')
    expect(r).toEqual({ ok: false, reason: 'malformed' })
  })

  test('legacy bare-hex WITHOUT fallbackProjectId → unscoped_legacy', () => {
    const legacyHmac = hmacFor('proj-1')
    expect(verifyRuntimeToken(legacyHmac)).toEqual({
      ok: false,
      reason: 'unscoped_legacy',
    })
  })

  test('legacy bare-hex with empty-string fallback → unscoped_legacy (falsy guard)', () => {
    const legacyHmac = hmacFor('proj-1')
    expect(verifyRuntimeToken(legacyHmac, '')).toEqual({
      ok: false,
      reason: 'unscoped_legacy',
    })
  })

  test('legacy bare-hex with wrong fallbackProjectId → bad_hmac (not unscoped)', () => {
    const legacyHmac = hmacFor('proj-1')
    expect(verifyRuntimeToken(legacyHmac, 'proj-NOT-1')).toEqual({
      ok: false,
      reason: 'bad_hmac',
    })
  })

  test('v1 token signed under a DIFFERENT secret → bad_hmac', () => {
    // Mint with the test secret...
    const t = deriveRuntimeToken('proj-1')
    // ...then verify under a different secret.
    process.env.AI_PROXY_SECRET = 'rotated-secret'
    expect(verifyRuntimeToken(t)).toEqual({ ok: false, reason: 'bad_hmac' })
  })

  test('v1 token with tampered hmac → bad_hmac', () => {
    const t = deriveRuntimeToken('proj-1')
    // Flip the last hex char deterministically (a → b, b → a, else → 0).
    const last = t.slice(-1)
    const flipped = last === 'a' ? 'b' : last === 'b' ? 'a' : '0'
    const tampered = t.slice(0, -1) + flipped
    expect(verifyRuntimeToken(tampered)).toEqual({ ok: false, reason: 'bad_hmac' })
  })

  test('v1 token with tampered embedded projectId → bad_hmac (scope check pinned)', () => {
    // Mint for proj-A, then rewrite the embedded projectId to proj-B
    // without recomputing the hmac. This is the canonical attack the
    // self-identifying format must catch: the hmac is bound to the
    // ORIGINAL projectId, not the tampered one.
    const t = deriveRuntimeToken('proj-A')
    const tampered = t.replace('_proj-A_', '_proj-B_')
    expect(tampered).not.toBe(t) // sanity: substitution actually fired
    expect(verifyRuntimeToken(tampered)).toEqual({ ok: false, reason: 'bad_hmac' })
  })

  test('one project\'s v1 token cannot be reused as another project\'s', () => {
    // Generate a fresh v1 token for proj-A, then verify it; recovered
    // scope should be proj-A and never something else.
    const t = deriveRuntimeToken('proj-A')
    const r = verifyRuntimeToken(t)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.projectId).toBe('proj-A')
  })
})

describe('verifyRuntimeToken — round-trip with deriveRuntimeToken', () => {
  test.each([
    ['simple', 'proj-1'],
    ['with-uppercase', 'Project-Awesome'],
    ['with-numbers', 'p123456'],
    ['with-underscores', 'team_alpha_proj_42'],
    ['long', 'a'.repeat(120)],
  ])('round-trips for projectId variant: %s', (_label, pid) => {
    const r = verifyRuntimeToken(deriveRuntimeToken(pid))
    expect(r).toEqual({ ok: true, projectId: pid, format: 'v1' })
  })
})
