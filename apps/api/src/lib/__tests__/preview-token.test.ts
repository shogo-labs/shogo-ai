// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  extractProjectIdFromToken,
  generatePreviewToken,
  verifyPreviewToken,
} from '../preview-token'

const TEST_SECRET = 'test-secret-do-not-use-in-prod'

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) prev[k] = process.env[k]
  return (async () => {
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await fn()
    } finally {
      for (const k of Object.keys(overrides)) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
    }
  })()
}

describe('preview-token', () => {
  let originalSecret: string | undefined
  let originalFallback: string | undefined
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalSecret = process.env.BETTER_AUTH_SECRET
    originalFallback = process.env.PREVIEW_TOKEN_SECRET
    originalNodeEnv = process.env.NODE_ENV
    process.env.BETTER_AUTH_SECRET = TEST_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = originalSecret
    if (originalFallback === undefined) delete process.env.PREVIEW_TOKEN_SECRET
    else process.env.PREVIEW_TOKEN_SECRET = originalFallback
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  describe('generatePreviewToken', () => {
    it('produces a 3-segment dot-separated JWT-style token', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1')
      const parts = token.split('.')
      expect(parts).toHaveLength(3)
      for (const p of parts) expect(p.length).toBeGreaterThan(0)
    })

    it('uses base64url alphabet (no +, /, or = padding)', async () => {
      const token = await generatePreviewToken('proj-with-padding-bytes', 'u')
      expect(token).not.toMatch(/[+/=]/)
    })

    it('encodes header with alg=HS256 and typ=JWT', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1')
      const [encHeader] = token.split('.')
      const decoded = JSON.parse(
        atob(encHeader.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((encHeader.length + 3) % 4)),
      )
      expect(decoded).toEqual({ alg: 'HS256', typ: 'JWT' })
    })

    it('embeds projectId, userId, and sane iat/exp', async () => {
      const before = Math.floor(Date.now() / 1000)
      const token = await generatePreviewToken('proj-42', 'user-42')
      const after = Math.floor(Date.now() / 1000)

      const payload = await verifyPreviewToken(token)
      expect(payload).not.toBeNull()
      expect(payload!.projectId).toBe('proj-42')
      expect(payload!.userId).toBe('user-42')
      expect(payload!.iat).toBeGreaterThanOrEqual(before)
      expect(payload!.iat).toBeLessThanOrEqual(after)
      // Default expiry is 1 hour
      expect(payload!.exp - payload!.iat).toBe(3600)
    })

    it('honours custom expiry', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1', 5_000)
      const payload = await verifyPreviewToken(token)
      expect(payload).not.toBeNull()
      expect(payload!.exp - payload!.iat).toBe(5)
    })

    it('omits userId when not provided', async () => {
      const token = await generatePreviewToken('proj-only')
      const payload = await verifyPreviewToken(token)
      expect(payload).not.toBeNull()
      expect(payload!.projectId).toBe('proj-only')
      expect(payload!.userId).toBeUndefined()
    })
  })

  describe('verifyPreviewToken', () => {
    it('returns null for a malformed token (not 3 parts)', async () => {
      expect(await verifyPreviewToken('not-a-token')).toBeNull()
      expect(await verifyPreviewToken('a.b')).toBeNull()
      expect(await verifyPreviewToken('a.b.c.d')).toBeNull()
    })

    it('returns null when signature is tampered', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1')
      const [h, p] = token.split('.')
      const tampered = `${h}.${p}.AAAAAAAA`
      expect(await verifyPreviewToken(tampered)).toBeNull()
    })

    it('returns null when payload is tampered (signature no longer matches)', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1')
      const [h, , s] = token.split('.')
      const fakePayload = btoa(JSON.stringify({ projectId: 'evil', exp: 9_999_999_999, iat: 0 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      expect(await verifyPreviewToken(`${h}.${fakePayload}.${s}`)).toBeNull()
    })

    it('returns null when signed with a different secret', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1')
      process.env.BETTER_AUTH_SECRET = 'different-secret'
      expect(await verifyPreviewToken(token)).toBeNull()
    })

    it('returns null for an expired token', async () => {
      const token = await generatePreviewToken('proj-1', 'user-1', -1000)
      expect(await verifyPreviewToken(token)).toBeNull()
    })

    it('returns null when payload is not valid JSON', async () => {
      const h = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const badPayload = btoa('{not json')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      // Make a valid-looking signature segment so length check passes
      const sig = 'AAAA'
      expect(await verifyPreviewToken(`${h}.${badPayload}.${sig}`)).toBeNull()
    })

    it('accepts a freshly generated token', async () => {
      const token = await generatePreviewToken('proj-roundtrip', 'user-roundtrip')
      const payload = await verifyPreviewToken(token)
      expect(payload?.projectId).toBe('proj-roundtrip')
    })
  })

  describe('extractProjectIdFromToken', () => {
    it('returns projectId without verifying signature', async () => {
      const token = await generatePreviewToken('proj-x', 'user-x')
      expect(extractProjectIdFromToken(token)).toBe('proj-x')
    })

    it('returns projectId even when signature is wrong (intentional, for routing)', async () => {
      const token = await generatePreviewToken('proj-routing', 'user-r')
      const [h, p] = token.split('.')
      expect(extractProjectIdFromToken(`${h}.${p}.AAAA`)).toBe('proj-routing')
    })

    it('returns null when token does not have 3 parts', () => {
      expect(extractProjectIdFromToken('garbage')).toBeNull()
      expect(extractProjectIdFromToken('a.b')).toBeNull()
    })

    it('returns null when payload is not valid JSON', () => {
      const h = 'aGVhZGVy'
      const bad = btoa('not-json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      expect(extractProjectIdFromToken(`${h}.${bad}.sig`)).toBeNull()
    })

    it('returns null when payload has no projectId', () => {
      const h = 'aGVhZGVy'
      const payload = btoa(JSON.stringify({ userId: 'u', iat: 1, exp: 2 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      expect(extractProjectIdFromToken(`${h}.${payload}.sig`)).toBeNull()
    })
  })

  describe('secret resolution', () => {
    it('falls back to PREVIEW_TOKEN_SECRET when BETTER_AUTH_SECRET is unset', async () => {
      await withEnv(
        { BETTER_AUTH_SECRET: undefined, PREVIEW_TOKEN_SECRET: 'fallback-secret', NODE_ENV: 'test' },
        async () => {
          const token = await generatePreviewToken('proj-1', 'user-1')
          const payload = await verifyPreviewToken(token)
          expect(payload?.projectId).toBe('proj-1')
        },
      )
    })

    it('uses dev fallback secret when neither env var is set (non-production)', async () => {
      await withEnv(
        { BETTER_AUTH_SECRET: undefined, PREVIEW_TOKEN_SECRET: undefined, NODE_ENV: 'development' },
        async () => {
          const token = await generatePreviewToken('proj-dev', 'user-dev')
          const payload = await verifyPreviewToken(token)
          expect(payload?.projectId).toBe('proj-dev')
        },
      )
    })

    it('throws in production when no signing secret is configured', async () => {
      await withEnv(
        { BETTER_AUTH_SECRET: undefined, PREVIEW_TOKEN_SECRET: undefined, NODE_ENV: 'production' },
        async () => {
          await expect(generatePreviewToken('proj-1', 'user-1')).rejects.toThrow(/No signing secret/)
        },
      )
    })
  })
})
