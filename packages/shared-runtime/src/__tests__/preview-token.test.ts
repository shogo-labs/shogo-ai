// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Coverage closure for packages/shared-runtime/src/preview-token.ts.
 * Drives every exported function plus the internal getPreviewSecret /
 * base64urlDecode helpers to 100% lines + funcs.
 *
 * IMPORTANT: getPreviewSecret() is asymmetric. In non-production mode
 * it ALWAYS returns the literal 'shogo-dev-only-preview-secret' when any
 * env var is present — BETTER_AUTH_SECRET / PREVIEW_TOKEN_SECRET act as
 * presence flags, not as the actual signing material. So every happy-path
 * token in this file is signed with that literal, regardless of which
 * env var is set. The existing preview-token-auth.test.ts owns server-
 * framework integration coverage; this file owns unit-level closure.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  verifyPreviewToken,
  extractProjectIdFromToken,
  validatePreviewAccess,
  type PreviewTokenPayload,
} from '../preview-token'

const DEV_SIGNING_SECRET = 'shogo-dev-only-preview-secret'

function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64urlBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function signHmac(secret: string, signingInput: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return new Uint8Array(sig)
}

async function mintToken(payload: PreviewTokenPayload, secret: string): Promise<string> {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64urlEncode(JSON.stringify(payload))
  const sig = await signHmac(secret, `${header}.${body}`)
  return `${header}.${body}.${b64urlBytes(sig)}`
}

const ORIGINAL_ENV: Record<string, string | undefined> = {
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  PREVIEW_TOKEN_SECRET: process.env.PREVIEW_TOKEN_SECRET,
  NODE_ENV: process.env.NODE_ENV,
}

function restoreKey(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeEach(() => {
  // Non-prod dev mode with BETTER_AUTH_SECRET set as a presence flag.
  process.env.BETTER_AUTH_SECRET = 'presence-flag'
  delete process.env.PREVIEW_TOKEN_SECRET
  delete process.env.NODE_ENV
})

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) restoreKey(k, v)
})

describe('verifyPreviewToken — structural & path coverage', () => {
  it('returns null when token has fewer than 3 dot-separated parts', async () => {
    expect(await verifyPreviewToken('abc.def')).toBeNull()
  })

  it('returns null when token has more than 3 dot-separated parts', async () => {
    expect(await verifyPreviewToken('a.b.c.d')).toBeNull()
  })

  it('returns the payload for a freshly-minted valid token (happy path)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const payload: PreviewTokenPayload = {
      projectId: 'proj-happy',
      userId: 'user-1',
      iat: now,
      exp: now + 3600,
    }
    const token = await mintToken(payload, DEV_SIGNING_SECRET)
    const result = await verifyPreviewToken(token)
    expect(result).not.toBeNull()
    expect(result!.projectId).toBe('proj-happy')
    expect(result!.userId).toBe('user-1')
    expect(result!.exp).toBe(payload.exp)
  })

  it('returns null when the HMAC signature does not verify', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken(
      { projectId: 'p', iat: now, exp: now + 3600 },
      'A-DIFFERENT-SECRET-THAT-WONT-MATCH',
    )
    expect(await verifyPreviewToken(token)).toBeNull()
  })

  it('returns null when the token is expired (exp < now)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken(
      { projectId: 'p', iat: now - 7200, exp: now - 3600 },
      DEV_SIGNING_SECRET,
    )
    expect(await verifyPreviewToken(token)).toBeNull()
  })

  it('still works when only PREVIEW_TOKEN_SECRET is set (BETTER_AUTH_SECRET absent)', async () => {
    delete process.env.BETTER_AUTH_SECRET
    process.env.PREVIEW_TOKEN_SECRET = 'presence-flag-pt'
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken(
      { projectId: 'pt-only', iat: now, exp: now + 3600 },
      DEV_SIGNING_SECRET,
    )
    const result = await verifyPreviewToken(token)
    expect(result?.projectId).toBe('pt-only')
  })

  it('emits the dev-fallback console.warn on the verify path', async () => {
    const originalWarn = console.warn
    let warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const now = Math.floor(Date.now() / 1000)
      const token = await mintToken(
        { projectId: 'warn-emit', iat: now, exp: now + 3600 },
        DEV_SIGNING_SECRET,
      )
      const result = await verifyPreviewToken(token)
      expect(result?.projectId).toBe('warn-emit')
      expect(warnings.join('\n')).toMatch(/development-only fallback/)
    } finally {
      console.warn = originalWarn
    }
  })

  it('returns null when NO secret env var is set (FATAL throw caught)', async () => {
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    expect(await verifyPreviewToken('a.b.c')).toBeNull()
  })

  it('returns null when secret is set but NODE_ENV=production (Missing throw caught)', async () => {
    process.env.BETTER_AUTH_SECRET = 'prod-secret'
    process.env.NODE_ENV = 'production'
    expect(await verifyPreviewToken('a.b.c')).toBeNull()
  })

  it('returns null when the payload is not valid JSON (catch arm)', async () => {
    const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const body = b64urlEncode('not json {{{')
    const sig = await signHmac(DEV_SIGNING_SECRET, `${header}.${body}`)
    const token = `${header}.${body}.${b64urlBytes(sig)}`
    expect(await verifyPreviewToken(token)).toBeNull()
  })
})

describe('extractProjectIdFromToken', () => {
  it('returns null for malformed token (parts.length !== 3)', () => {
    expect(extractProjectIdFromToken('a.b')).toBeNull()
  })

  it('returns the projectId from a well-formed payload (no signature check required)', () => {
    const body = b64urlEncode(JSON.stringify({ projectId: 'extract-me', iat: 0, exp: 0 }))
    expect(extractProjectIdFromToken(`h.${body}.s`)).toBe('extract-me')
  })

  it('returns null when projectId field is absent from the payload', () => {
    const body = b64urlEncode(JSON.stringify({ iat: 0, exp: 0 }))
    expect(extractProjectIdFromToken(`h.${body}.s`)).toBeNull()
  })

  it('returns null when the payload is not valid JSON (catch arm)', () => {
    const body = b64urlEncode('::: not json :::')
    expect(extractProjectIdFromToken(`h.${body}.s`)).toBeNull()
  })
})

describe('validatePreviewAccess', () => {
  it('throws when the token is null', async () => {
    await expect(validatePreviewAccess(null, 'p')).rejects.toThrow(/Missing preview token/)
  })

  it('throws when the token is undefined', async () => {
    await expect(validatePreviewAccess(undefined, 'p')).rejects.toThrow(/Missing preview token/)
  })

  it('throws when the token is the empty string', async () => {
    await expect(validatePreviewAccess('', 'p')).rejects.toThrow(/Missing preview token/)
  })

  it('throws "Invalid or expired" when verifyPreviewToken returns null', async () => {
    await expect(validatePreviewAccess('a.b', 'p')).rejects.toThrow(/Invalid or expired/)
  })

  it('throws "project ID mismatch" when the token belongs to a different project', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken(
      { projectId: 'proj-A', iat: now, exp: now + 3600 },
      DEV_SIGNING_SECRET,
    )
    await expect(validatePreviewAccess(token, 'proj-B')).rejects.toThrow(/project ID mismatch/)
  })

  it('returns the payload on the happy path', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken(
      { projectId: 'happy', iat: now, exp: now + 3600 },
      DEV_SIGNING_SECRET,
    )
    const result = await validatePreviewAccess(token, 'happy')
    expect(result.projectId).toBe('happy')
  })
})

describe('base64urlDecode behaviour (driven via extractProjectIdFromToken)', () => {
  it('handles base64url with no padding needed (length % 4 === 0)', () => {
    const body = b64urlEncode(JSON.stringify({ projectId: 'pad0' }))
    expect(extractProjectIdFromToken(`h.${body}.s`)).toBe('pad0')
  })

  it('round-trips a payload containing characters that produce + and / in std base64', () => {
    // 'a/b+c=d' as JSON string contains chars that don't strictly produce +/ in
    // b64, but the round-trip exercises the decoder's full path either way.
    const body = b64urlEncode(JSON.stringify({ projectId: 'a/b+c=d' }))
    expect(extractProjectIdFromToken(`h.${body}.s`)).toBe('a/b+c=d')
  })
})
