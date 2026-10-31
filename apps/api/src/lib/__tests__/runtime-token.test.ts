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

describe('the dev-only fallback never signs a token that leaves the process', () => {
  // Every case here runs with the file's own signing secret removed, so
  // `getSigningSecret()` falls through to its localhost-only default.
  const saved = {
    aiProxy: process.env.AI_PROXY_SECRET,
    better: process.env.BETTER_AUTH_SECRET,
    preview: process.env.PREVIEW_TOKEN_SECRET,
    nodeEnv: process.env.NODE_ENV,
    k8s: process.env.KUBERNETES_SERVICE_HOST,
  }
  const restore = () => {
    const put = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    put('AI_PROXY_SECRET', saved.aiProxy)
    put('BETTER_AUTH_SECRET', saved.better)
    put('PREVIEW_TOKEN_SECRET', saved.preview)
    put('NODE_ENV', saved.nodeEnv)
    put('KUBERNETES_SERVICE_HOST', saved.k8s)
  }

  test('refuses to mint in-cluster when the fallback is all it has', () => {
    // The warm-pool-rescue Job: NODE_ENV=staging, no signing secret in its env,
    // running in-cluster. Before SHO-265 this minted a token for every pod it
    // healed that the API rejected as bad_hmac.
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'staging'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    try {
      expect(() => deriveRuntimeToken('proj-heal')).toThrow(/localhost-only signing secret inside a cluster/)
    } finally {
      restore()
    }
  })

  test('mints in-cluster with the secret the API uses, and it verifies', () => {
    delete process.env.AI_PROXY_SECRET
    process.env.BETTER_AUTH_SECRET = 'better-auth-secret-from-api-secrets'
    process.env.NODE_ENV = 'staging'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    try {
      const token = deriveRuntimeToken('proj-heal')
      expect(verifyRuntimeToken(token)).toMatchObject({ ok: true, projectId: 'proj-heal', format: 'v1' })
    } finally {
      delete process.env.BETTER_AUTH_SECRET
      restore()
    }
  })

  test('a test process that sets KUBERNETES_SERVICE_HOST still mints', () => {
    // The export and workspace-move suites set it deliberately to exercise
    // Kubernetes mode; keying the guard on it alone failed 8 export cases and an
    // E2E move (SHO-265 round 4).
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.NODE_ENV = 'test'
    try {
      expect(() => deriveRuntimeToken('proj-k8s-mode')).not.toThrow()
    } finally {
      restore()
    }
  })

  test('local dev (not in a cluster) still mints with the fallback', () => {
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    delete process.env.KUBERNETES_SERVICE_HOST
    process.env.NODE_ENV = 'development'
    try {
      const token = deriveRuntimeToken('proj-local')
      expect(verifyRuntimeToken(token)).toMatchObject({ ok: true, projectId: 'proj-local' })
    } finally {
      restore()
    }
  })

  test('verification still degrades to bad_hmac instead of throwing in that job', () => {
    // The verifier must never turn a bad token into a 500: the reason is what
    // makes the log line actionable, and an in-cluster caller can legitimately
    // hold tokens it did not sign.
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'staging'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    try {
      const foreign = `${RUNTIME_TOKEN_V1_PREFIX}proj-heal_${'a'.repeat(64)}`
      expect(verifyRuntimeToken(foreign)).toEqual({ ok: false, reason: 'bad_hmac' })
    } finally {
      restore()
    }
  })
})
