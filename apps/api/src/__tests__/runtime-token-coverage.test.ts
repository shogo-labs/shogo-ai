// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage-gap tests for `lib/runtime-token`.
 *
 * The main `auth-runtime-token.test.ts` covers the happy paths and the
 * documented verifier reasons. This file pins the micro-branches that
 * were uncovered in the coverage report:
 *
 *   - getSigningSecret production-no-secret tripwire (lines 62-67)
 *   - deriveRuntimeToken empty-projectId guard (line 112)
 *   - parseRuntimeToken v1 structural edge cases (lines 154-157):
 *       * separator before HMAC is not "_"
 *       * empty projectId portion
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  RUNTIME_TOKEN_V1_PREFIX,
  deriveRuntimeToken,
  parseRuntimeToken,
  verifyRuntimeToken,
} from '../lib/runtime-token'

const ENV_KEYS = [
  'AI_PROXY_SECRET',
  'BETTER_AUTH_SECRET',
  'PREVIEW_TOKEN_SECRET',
  'NODE_ENV',
] as const
const snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) snapshot[k] = process.env[k]
  // Ensure a deterministic dev-mode default for the happy paths.
  delete process.env.NODE_ENV
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
})

describe('getSigningSecret — production-no-secret tripwire', () => {
  test('deriveRuntimeToken throws when NODE_ENV=production and no secret is set', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    expect(() => deriveRuntimeToken('proj_x')).toThrow(
      /\[RuntimeToken\] FATAL: No signing secret configured/
    )
  })

  test('the production tripwire mentions both AI_PROXY_SECRET and BETTER_AUTH_SECRET', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    try {
      deriveRuntimeToken('proj_x')
      throw new Error('expected throw')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('AI_PROXY_SECRET')
      expect(msg).toContain('BETTER_AUTH_SECRET')
    }
  })

  test('AI_PROXY_SECRET satisfies the production guard', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.AI_PROXY_SECRET = 'prod-ai-secret'

    expect(() => deriveRuntimeToken('proj_x')).not.toThrow()
  })

  test('BETTER_AUTH_SECRET satisfies the production guard', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.BETTER_AUTH_SECRET = 'prod-auth-secret'

    expect(() => deriveRuntimeToken('proj_x')).not.toThrow()
  })

  test('PREVIEW_TOKEN_SECRET satisfies the production guard', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    process.env.PREVIEW_TOKEN_SECRET = 'prod-preview-secret'

    expect(() => deriveRuntimeToken('proj_x')).not.toThrow()
  })

  test('non-production with no secret falls through to the dev default (no throw)', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    expect(() => deriveRuntimeToken('proj_dev')).not.toThrow()
  })

  test('test env with no secret falls through to the dev default (no throw)', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    expect(() => deriveRuntimeToken('proj_t')).not.toThrow()
  })

  test('empty NODE_ENV (treated as non-prod) falls through to dev default', () => {
    process.env.NODE_ENV = ''
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    expect(() => deriveRuntimeToken('proj_e')).not.toThrow()
  })
})

describe('deriveRuntimeToken — empty projectId guard', () => {
  test('throws for an empty projectId', () => {
    expect(() => deriveRuntimeToken('')).toThrow(
      /\[RuntimeToken\] deriveRuntimeToken: projectId is required/
    )
  })

  test('the guard is the first thing that runs (does not touch the signing secret)', () => {
    // Even in a perfectly broken prod-no-secret state, the empty-projectId
    // check must fire first — that error is the actionable one for callers.
    process.env.NODE_ENV = 'production'
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET

    expect(() => deriveRuntimeToken('')).toThrow(/projectId is required/)
  })
})

describe('parseRuntimeToken — v1 structural edge cases', () => {
  test('returns null when the byte before the HMAC is not "_" separator', () => {
    // Build a token where the separator slot is `-` instead of `_`.
    const hmac = 'a'.repeat(64)
    const token = `${RUNTIME_TOKEN_V1_PREFIX}proj-${hmac}` // separator is `-`, not `_`
    expect(parseRuntimeToken(token)).toBeNull()
  })

  test('returns null when the byte before the HMAC is any non-underscore char', () => {
    const hmac = 'b'.repeat(64)
    for (const sep of ['-', '.', ':', '/', '|', '0']) {
      const token = `${RUNTIME_TOKEN_V1_PREFIX}proj${sep}${hmac}`
      expect(parseRuntimeToken(token)).toBeNull()
    }
  })

  test('returns null when projectId portion is empty (rest starts with "_")', () => {
    // `rt_v1_` + `_` + 64 hex → length = 66, passes the min-length check,
    // separator IS `_`, but the projectId slice is empty.
    const hmac = 'c'.repeat(64)
    const token = `${RUNTIME_TOKEN_V1_PREFIX}_${hmac}`
    expect(parseRuntimeToken(token)).toBeNull()
  })

  test('returns null when HMAC portion contains non-hex characters', () => {
    // 64 chars but not all hex.
    const badHmac = 'g'.repeat(64) // 'g' is outside [0-9a-f]
    const token = `${RUNTIME_TOKEN_V1_PREFIX}proj_${badHmac}`
    expect(parseRuntimeToken(token)).toBeNull()
  })

  test('returns null when HMAC portion contains uppercase hex (regex is lowercase only)', () => {
    const upperHmac = 'A'.repeat(64)
    const token = `${RUNTIME_TOKEN_V1_PREFIX}proj_${upperHmac}`
    expect(parseRuntimeToken(token)).toBeNull()
  })

  test('verifyRuntimeToken surfaces these structural failures as "malformed"', () => {
    const hmac = 'd'.repeat(64)
    expect(verifyRuntimeToken(`${RUNTIME_TOKEN_V1_PREFIX}proj-${hmac}`)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(verifyRuntimeToken(`${RUNTIME_TOKEN_V1_PREFIX}_${hmac}`)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  test('parseRuntimeToken accepts a multi-char projectId with underscores inside', () => {
    // The separator is the LAST underscore before the HMAC, so projectIds
    // containing underscores must still parse correctly.
    const projectId = 'proj_with_underscores'
    const realToken = deriveRuntimeToken(projectId)
    const parsed = parseRuntimeToken(realToken)
    expect(parsed).not.toBeNull()
    expect(parsed!.format).toBe('v1')
    if (parsed!.format === 'v1') expect(parsed!.projectId).toBe(projectId)
  })
})
