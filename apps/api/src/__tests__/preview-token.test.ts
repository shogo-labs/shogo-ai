// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  extractProjectIdFromToken,
  generatePreviewToken,
  verifyPreviewToken,
  type PreviewTokenPayload,
} from '../lib/preview-token'

// Use an explicit secret so tests don't depend on whatever the host env has.
const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET
const ORIGINAL_FALLBACK = process.env.PREVIEW_TOKEN_SECRET
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = 'test-preview-token-secret-do-not-use-in-prod'
  delete process.env.PREVIEW_TOKEN_SECRET
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET
  if (ORIGINAL_FALLBACK === undefined) delete process.env.PREVIEW_TOKEN_SECRET
  else process.env.PREVIEW_TOKEN_SECRET = ORIGINAL_FALLBACK
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV
})

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  return atob(pad)
}

describe('generatePreviewToken', () => {
  test('emits a three-part JWT-style token', async () => {
    const token = await generatePreviewToken('proj_abc', 'user_xyz')
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    for (const part of parts) {
      // base64url alphabet only — no '+', '/', or padding '='.
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(part.length).toBeGreaterThan(0)
    }
  })

  test('header advertises HS256 / JWT', async () => {
    const token = await generatePreviewToken('proj_abc')
    const [headerPart] = token.split('.')
    const header = JSON.parse(base64urlDecode(headerPart))
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
  })

  test('payload carries projectId, userId, and a forward-dated exp', async () => {
    const before = Math.floor(Date.now() / 1000)
    const token = await generatePreviewToken('proj_abc', 'user_xyz')
    const after = Math.floor(Date.now() / 1000)

    const [, payloadPart] = token.split('.')
    const payload = JSON.parse(base64urlDecode(payloadPart)) as PreviewTokenPayload

    expect(payload.projectId).toBe('proj_abc')
    expect(payload.userId).toBe('user_xyz')
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
    // Default expiry is one hour from `iat`.
    expect(payload.exp - payload.iat).toBe(3600)
  })

  test('omits userId when none is supplied', async () => {
    const token = await generatePreviewToken('proj_no_user')
    const payload = JSON.parse(base64urlDecode(token.split('.')[1])) as PreviewTokenPayload
    expect(payload.projectId).toBe('proj_no_user')
    expect(payload.userId).toBeUndefined()
  })

  test('honors a custom expiry in milliseconds', async () => {
    const token = await generatePreviewToken('proj_short', undefined, 60_000)
    const payload = JSON.parse(base64urlDecode(token.split('.')[1])) as PreviewTokenPayload
    expect(payload.exp - payload.iat).toBe(60)
  })

  test('two tokens for the same input have different signatures only if iat advances', async () => {
    // Tokens are deterministic functions of (header, payload, secret) — if
    // both are issued in the same second they produce identical strings.
    // We verify the *shape* is stable; signature drift is exercised via
    // verifyPreviewToken accepting both.
    const t1 = await generatePreviewToken('proj_dup', 'user_dup')
    const t2 = await generatePreviewToken('proj_dup', 'user_dup')
    expect(t1.split('.')).toHaveLength(3)
    expect(t2.split('.')).toHaveLength(3)
    // Both must verify under the same secret.
    expect(await verifyPreviewToken(t1)).not.toBeNull()
    expect(await verifyPreviewToken(t2)).not.toBeNull()
  })
})

describe('verifyPreviewToken', () => {
  test('round-trips a freshly issued token', async () => {
    const token = await generatePreviewToken('proj_round_trip', 'user_round_trip')
    const verified = await verifyPreviewToken(token)
    expect(verified).not.toBeNull()
    expect(verified!.projectId).toBe('proj_round_trip')
    expect(verified!.userId).toBe('user_round_trip')
  })

  test('returns null for a token with a malformed structure', async () => {
    expect(await verifyPreviewToken('not-a-token')).toBeNull()
    expect(await verifyPreviewToken('only.two')).toBeNull()
    expect(await verifyPreviewToken('a.b.c.d')).toBeNull()
    expect(await verifyPreviewToken('')).toBeNull()
  })

  test('returns null when the signature has been tampered with', async () => {
    const token = await generatePreviewToken('proj_tamper')
    const [h, p] = token.split('.')
    // Replace the signature with a valid-looking but wrong one.
    const bogus = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
    expect(await verifyPreviewToken(bogus)).toBeNull()
  })

  test('returns null when the payload has been tampered with', async () => {
    const token = await generatePreviewToken('proj_orig')
    const [h, , s] = token.split('.')
    // Forge a payload claiming a different project but reuse the original
    // signature. The HMAC will no longer match.
    const forged = btoa(JSON.stringify({
      projectId: 'proj_attacker',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await verifyPreviewToken(`${h}.${forged}.${s}`)).toBeNull()
  })

  test('returns null when the token is signed with a different secret', async () => {
    const token = await generatePreviewToken('proj_wrong_key')
    process.env.BETTER_AUTH_SECRET = 'a-completely-different-secret-value'
    try {
      expect(await verifyPreviewToken(token)).toBeNull()
    } finally {
      process.env.BETTER_AUTH_SECRET = 'test-preview-token-secret-do-not-use-in-prod'
    }
  })

  test('returns null for an expired token', async () => {
    // Issue a token that has already expired (negative window).
    const token = await generatePreviewToken('proj_expired', 'user', -1000)
    expect(await verifyPreviewToken(token)).toBeNull()
  })

  test('returns null when the payload is unparseable JSON', async () => {
    // Hand-craft a token: valid header, garbage payload, plausible signature shape.
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const payload = btoa('not json at all')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fake = `${header}.${payload}.AAAA`
    expect(await verifyPreviewToken(fake)).toBeNull()
  })
})

describe('extractProjectIdFromToken', () => {
  test('returns the projectId from a well-formed token without verifying signature', async () => {
    const token = await generatePreviewToken('proj_extract', 'user_extract')
    expect(extractProjectIdFromToken(token)).toBe('proj_extract')
  })

  test('returns null for a token with the wrong number of parts', () => {
    expect(extractProjectIdFromToken('only.two')).toBeNull()
    expect(extractProjectIdFromToken('a.b.c.d')).toBeNull()
    expect(extractProjectIdFromToken('')).toBeNull()
  })

  test('returns null when the payload segment is not valid base64/JSON', () => {
    expect(extractProjectIdFromToken('aaa.!!!not-base64!!!.bbb')).toBeNull()
  })

  test('returns null when the payload has no projectId field', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const payload = btoa(JSON.stringify({ userId: 'u', iat: 0, exp: 1 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(extractProjectIdFromToken(`${header}.${payload}.sig`)).toBeNull()
  })

  test('does NOT validate signature or expiry (by design — routing helper)', async () => {
    // Even an expired or tampered token still yields its claimed projectId.
    const expired = await generatePreviewToken('proj_routing', 'u', -1000)
    expect(extractProjectIdFromToken(expired)).toBe('proj_routing')
  })
})
