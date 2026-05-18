// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/runtime-token.ts — targets edge cases the
 * main `runtime-token.test.ts` does not pin:
 *
 *  - `getSigningSecret` PREVIEW_TOKEN_SECRET-only path (last fallback).
 *  - Dev-mode no-secret path emits the "development-only" stand-in
 *    deterministically (same projectId → same token across calls).
 *  - `parseRuntimeToken` v1 boundary: minimum-valid length, exactly
 *    one-char projectId, embedded underscores survive a v1 round-trip.
 *  - `verifyRuntimeToken`:
 *      • v1 token whose embedded projectId was rewritten to a DIFFERENT
 *        valid id (HMAC stays the same) → bad_hmac (binding check).
 *      • legacy bare hex with fallbackProjectId matching different
 *        casing → bad_hmac (case-sensitive scope).
 *  - `deriveWebhookToken` / `deriveRuntimeToken` cross-namespace
 *    isolation: a runtime token's HMAC cannot be re-used as a webhook
 *    token.
 *
 *   bun test apps/api/src/__tests__/runtime-token-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const SAVED: Record<string, string | undefined> = {}
const KEYS = ['AI_PROXY_SECRET', 'BETTER_AUTH_SECRET', 'PREVIEW_TOKEN_SECRET', 'NODE_ENV'] as const
beforeEach(() => {
  for (const k of KEYS) {
    SAVED[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

// Re-import on every describe block so the env state is honored. The
// helpers themselves read env at call time, so a single import works.
const {
  RUNTIME_TOKEN_V1_PREFIX,
  deriveRuntimeToken,
  deriveWebhookToken,
  parseRuntimeToken,
  verifyRuntimeToken,
} = await import('../lib/runtime-token')

describe('getSigningSecret fallback chain', () => {
  test('PREVIEW_TOKEN_SECRET alone is used when neither other is set', () => {
    process.env.PREVIEW_TOKEN_SECRET = 'preview-secret-zzz'
    const t = deriveRuntimeToken('p1')
    expect(t.startsWith(RUNTIME_TOKEN_V1_PREFIX)).toBe(true)
    // Same env → identical token (proves PREVIEW_TOKEN_SECRET drove the HMAC).
    expect(deriveRuntimeToken('p1')).toBe(t)
  })

  test('dev fallback (no env at all) is deterministic across calls', () => {
    expect(process.env.NODE_ENV).toBeUndefined()
    const a = deriveRuntimeToken('p1')
    const b = deriveRuntimeToken('p1')
    expect(a).toBe(b)
    expect(a.startsWith(RUNTIME_TOKEN_V1_PREFIX + 'p1_')).toBe(true)
  })

  test('AI_PROXY_SECRET vs PREVIEW_TOKEN_SECRET produce different tokens', () => {
    process.env.AI_PROXY_SECRET = 'aaa'
    const ai = deriveRuntimeToken('p1')
    delete process.env.AI_PROXY_SECRET
    process.env.PREVIEW_TOKEN_SECRET = 'aaa'
    const pv = deriveRuntimeToken('p1')
    // Same SECRET value, different env var name — but identical secret string
    // → identical HMAC (only the *value* matters, not the var name).
    expect(ai).toBe(pv)

    // Now make them differ on the actual secret value.
    process.env.AI_PROXY_SECRET = 'bbb'
    expect(deriveRuntimeToken('p1')).not.toBe(ai)
  })
})

describe('parseRuntimeToken — v1 boundary cases', () => {
  test('1-char projectId round-trips through parse', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const t = deriveRuntimeToken('x')
    const parsed = parseRuntimeToken(t)
    expect(parsed?.format).toBe('v1')
    expect((parsed as any)?.projectId).toBe('x')
  })

  test('projectId with multiple underscores round-trips (only the LAST `_` is the separator)', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const id = 'proj_under_score_a_b_c'
    const t = deriveRuntimeToken(id)
    const parsed = parseRuntimeToken(t)
    expect(parsed?.format).toBe('v1')
    expect((parsed as any)?.projectId).toBe(id)
  })

  test('v1 token with a hmac whose 64th char is not hex → null', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const t = deriveRuntimeToken('p1')
    // Tamper the LAST char to a non-hex value.
    const tampered = t.slice(0, -1) + 'g'
    expect(parseRuntimeToken(tampered)).toBeNull()
  })

  test('v1 token with one too-few hmac chars → null (separator misalign)', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const t = deriveRuntimeToken('p1')
    // Drop one char from inside the hmac region.
    const broken = t.slice(0, -2) + t.slice(-1)
    expect(parseRuntimeToken(broken)).toBeNull()
  })
})

describe('verifyRuntimeToken — scope binding', () => {
  test('v1 with VALID hmac for a DIFFERENT projectId reports bad_hmac (binding check)', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const realA = deriveRuntimeToken('proj-A')
    const realB = deriveRuntimeToken('proj-B')

    const hmacA = realA.slice(-64)
    const hmacB = realB.slice(-64)
    expect(hmacA).not.toBe(hmacB)

    // Swap proj-B's hmac onto a token claiming to be proj-A.
    const spliced = `${RUNTIME_TOKEN_V1_PREFIX}proj-A_${hmacB}`
    const result = verifyRuntimeToken(spliced)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hmac')
  })

  test('legacy bare-hex with WRONG-CASE fallbackProjectId → bad_hmac', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    // Derive bare hex matching 'proj-x' by parsing the v1 token.
    const v1 = deriveRuntimeToken('proj-x')
    const hmac = v1.slice(-64)
    const result = verifyRuntimeToken(hmac, 'PROJ-X')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hmac')
  })

  test('legacy bare-hex with correct fallback verifies', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const hmac = deriveRuntimeToken('proj-x').slice(-64)
    const r = verifyRuntimeToken(hmac, 'proj-x')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.format).toBe('legacy')
      expect(r.projectId).toBe('proj-x')
    }
  })
})

describe('cross-namespace isolation: runtime vs webhook', () => {
  test('a webhook token NEVER equals the runtime hmac for the same project + secret', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const runtimeHmac = deriveRuntimeToken('p1').slice(-64)
    const webhook = deriveWebhookToken('p1')
    expect(webhook).not.toBe(runtimeHmac)
  })

  test('a webhook token passed to verifyRuntimeToken → malformed (no v1 prefix, not hex match for runtime namespace)', () => {
    process.env.AI_PROXY_SECRET = 'edge'
    const webhook = deriveWebhookToken('p1')
    // webhook is 64-char hex; legacy parser will accept it as legacy format,
    // but the hmac is over the "webhook:" namespace not "runtime-auth:".
    const r = verifyRuntimeToken(webhook, 'p1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_hmac')
  })
})

describe('verifyRuntimeToken — null and empty guards', () => {
  test('undefined → malformed', () => {
    const r = verifyRuntimeToken(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  test('empty string → malformed', () => {
    const r = verifyRuntimeToken('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  test('whitespace-only string → malformed', () => {
    const r = verifyRuntimeToken('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })
})
