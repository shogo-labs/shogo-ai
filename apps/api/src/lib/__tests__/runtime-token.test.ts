// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the runtime-token primitives:
 *
 *   - `deriveRuntimeToken` — v1 self-identifying format
 *   - `parseRuntimeToken`  — structural classifier (v1 / legacy / null)
 *   - `verifyRuntimeToken` — format-agnostic HMAC check
 *
 * The auth-middleware integration is covered separately in
 * `auth-runtime-token.test.ts`; this file exercises the primitives
 * directly so format regressions can't hide behind the middleware.
 */

import { describe, test, expect } from 'bun:test'
import { createHmac } from 'crypto'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'

const {
  deriveRuntimeToken,
  deriveWebhookToken,
  parseRuntimeToken,
  verifyRuntimeToken,
  RUNTIME_TOKEN_V1_PREFIX,
} = await import('../runtime-token')

function legacyHex(projectId: string): string {
  return createHmac('sha256', process.env.AI_PROXY_SECRET!)
    .update(`runtime-auth:${projectId}`)
    .digest('hex')
}

describe('deriveRuntimeToken (v1 format)', () => {
  test('returns rt_v1_<projectId>_<64hex> for a uuid projectId', () => {
    const projectId = 'b3be0bcd-a5e4-4769-95e3-f91fe78fe99d'
    const token = deriveRuntimeToken(projectId)
    expect(token.startsWith(RUNTIME_TOKEN_V1_PREFIX)).toBe(true)
    expect(token).toMatch(
      /^rt_v1_[0-9a-f-]{36}_[0-9a-f]{64}$/,
    )
    // Embedded projectId survives a round-trip through parse.
    const parsed = parseRuntimeToken(token)
    expect(parsed?.format).toBe('v1')
    if (parsed?.format === 'v1') {
      expect(parsed.projectId).toBe(projectId)
      expect(parsed.hmac).toBe(legacyHex(projectId))
    }
  })

  test('is deterministic for a given projectId', () => {
    expect(deriveRuntimeToken('proj_det')).toBe(deriveRuntimeToken('proj_det'))
  })

  test('differs across projectIds (scope isolation)', () => {
    expect(deriveRuntimeToken('proj_a')).not.toBe(deriveRuntimeToken('proj_b'))
  })

  test('refuses empty projectId (defensive — caller bug, not silent empty scope)', () => {
    expect(() => deriveRuntimeToken('')).toThrow()
  })
})

describe('deriveWebhookToken (unchanged bare-hex format)', () => {
  test('is still bare 64-char hex (intentionally not v1)', () => {
    // Webhook URLs always carry projectId in the path, so embedding it
    // in the token is pure cosmetics. Kept as bare hex so existing
    // external integrations keep working; can be upgraded later if we
    // ever hit a parallel use case.
    expect(deriveWebhookToken('proj_x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseRuntimeToken', () => {
  test('recognizes a v1 token', () => {
    const projectId = 'proj_parse_v1'
    const token = deriveRuntimeToken(projectId)
    const parsed = parseRuntimeToken(token)
    expect(parsed?.format).toBe('v1')
  })

  test('recognizes a legacy bare 64-hex token', () => {
    const parsed = parseRuntimeToken(legacyHex('proj_legacy'))
    expect(parsed?.format).toBe('legacy')
  })

  test('rejects an empty string', () => {
    expect(parseRuntimeToken('')).toBeNull()
  })

  test('rejects an api key that happens to share the rt_ family', () => {
    expect(parseRuntimeToken('shogo_sk_bogus')).toBeNull()
  })

  test('rejects v1 with non-hex hmac suffix', () => {
    expect(
      parseRuntimeToken(`${RUNTIME_TOKEN_V1_PREFIX}proj_x_` + 'z'.repeat(64)),
    ).toBeNull()
  })

  test('rejects v1 with too-short tail (no room for hmac)', () => {
    expect(parseRuntimeToken(`${RUNTIME_TOKEN_V1_PREFIX}proj_x_abc`)).toBeNull()
  })

  test('rejects v1 with missing underscore separator before hmac', () => {
    // 64 hex but glued to projectId without the `_` separator.
    const bad = `${RUNTIME_TOKEN_V1_PREFIX}projx${'a'.repeat(64)}`
    expect(parseRuntimeToken(bad)).toBeNull()
  })
})

describe('verifyRuntimeToken', () => {
  test('v1 token: verifies and returns the embedded projectId', () => {
    const projectId = 'proj_verify_v1'
    const token = deriveRuntimeToken(projectId)
    const result = verifyRuntimeToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.projectId).toBe(projectId)
      expect(result.format).toBe('v1')
    }
  })

  test('v1 token: ignores a caller-supplied fallbackProjectId (scope comes from token)', () => {
    const realProject = 'proj_real'
    const token = deriveRuntimeToken(realProject)
    const result = verifyRuntimeToken(token, 'proj_attacker_wants_this')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.projectId).toBe(realProject)
  })

  test('legacy hex: verifies when fallbackProjectId matches', () => {
    const projectId = 'proj_legacy_match'
    const result = verifyRuntimeToken(legacyHex(projectId), projectId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.projectId).toBe(projectId)
      expect(result.format).toBe('legacy')
    }
  })

  test('legacy hex: rejects when fallbackProjectId does not match', () => {
    const result = verifyRuntimeToken(legacyHex('proj_a'), 'proj_b')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hmac')
  })

  test('legacy hex: rejects without any fallbackProjectId (we do not brute-force scope)', () => {
    const result = verifyRuntimeToken(legacyHex('proj_orphan'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unscoped_legacy')
  })

  test('malformed input → malformed reason', () => {
    expect(verifyRuntimeToken('').ok).toBe(false)
    expect(verifyRuntimeToken(undefined).ok).toBe(false)
    expect(verifyRuntimeToken(null).ok).toBe(false)
    expect(verifyRuntimeToken('not-a-runtime-token').ok).toBe(false)
    expect(verifyRuntimeToken('shogo_sk_fake').ok).toBe(false)
  })

  test('v1 token with tampered hmac → bad_hmac', () => {
    const good = deriveRuntimeToken('proj_tamper')
    const last = good.slice(-1)
    const bad = good.slice(0, -1) + (last === 'a' ? 'b' : 'a')
    const result = verifyRuntimeToken(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hmac')
  })

  test('v1 token whose embedded projectId was tampered → bad_hmac (HMAC pins scope)', () => {
    // Attacker swaps the embedded projectId hoping the verifier trusts
    // it blindly. The HMAC was computed for the ORIGINAL projectId, so
    // the check fails — the projectId is not a capability, the HMAC is.
    const original = 'proj_original'
    const token = deriveRuntimeToken(original)
    const hmac = token.slice(-64)
    const forged = `${RUNTIME_TOKEN_V1_PREFIX}proj_attacker_${hmac}`
    const result = verifyRuntimeToken(forged)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hmac')
  })
})
