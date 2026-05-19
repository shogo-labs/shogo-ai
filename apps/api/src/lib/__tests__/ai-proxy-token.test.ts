// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Set the signing secret BEFORE import so getProxySecret() captures it.
process.env.AI_PROXY_SECRET = 'wave2a-test-secret'
delete process.env.BETTER_AUTH_SECRET
delete process.env.PREVIEW_TOKEN_SECRET

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const {
  generateProxyToken,
  verifyProxyToken,
  extractProjectIdFromProxyToken,
} = await import('../ai-proxy-token')

const savedNodeEnv = process.env.NODE_ENV
const savedAiSecret = process.env.AI_PROXY_SECRET

afterEach(() => {
  process.env.AI_PROXY_SECRET = savedAiSecret
  process.env.NODE_ENV = savedNodeEnv
})

describe('generateProxyToken / verifyProxyToken — happy path', () => {
  it('round-trips a token and recovers the payload', async () => {
    const token = await generateProxyToken('p1', 'w1', 'u1')
    expect(typeof token).toBe('string')
    expect(token.split('.')).toHaveLength(3)
    const payload = await verifyProxyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.projectId).toBe('p1')
    expect(payload!.workspaceId).toBe('w1')
    expect(payload!.userId).toBe('u1')
    expect(payload!.type).toBe('ai-proxy')
    expect(payload!.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(payload!.exp).toBeGreaterThan(payload!.iat)
  })

  it('omits userId when not provided', async () => {
    const token = await generateProxyToken('p2', 'w2')
    const payload = await verifyProxyToken(token)
    expect(payload!.userId).toBeUndefined()
  })

  it('honours a custom expiryMs', async () => {
    const oneHour = 60 * 60 * 1000
    const token = await generateProxyToken('p3', 'w3', undefined, oneHour)
    const payload = await verifyProxyToken(token)
    expect(payload!.exp - payload!.iat).toBeGreaterThanOrEqual(60 * 60 - 1)
    expect(payload!.exp - payload!.iat).toBeLessThanOrEqual(60 * 60 + 1)
  })
})

describe('verifyProxyToken — error paths', () => {
  it('returns null when token has fewer than 3 parts', async () => {
    expect(await verifyProxyToken('aa.bb')).toBeNull()
    expect(await verifyProxyToken('only-one-part')).toBeNull()
  })

  it('returns null when signature is wrong', async () => {
    const token = await generateProxyToken('p', 'w')
    const [h, p] = token.split('.')
    const bad = `${h}.${p}.AAAA`
    expect(await verifyProxyToken(bad)).toBeNull()
  })

  it('returns null when payload type mismatches', async () => {
    // Generate a token, then tamper with payload to be a non ai-proxy type.
    const token = await generateProxyToken('p', 'w')
    const [h, p, s] = token.split('.')
    const decoded = JSON.parse(
      Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    )
    decoded.type = 'something-else'
    const reencoded = Buffer.from(JSON.stringify(decoded)).toString('base64url')
    const tampered = `${h}.${reencoded}.${s}`
    expect(await verifyProxyToken(tampered)).toBeNull()
  })

  it('returns null when token is expired', async () => {
    const past = -1000
    const token = await generateProxyToken('p', 'w', undefined, past)
    expect(await verifyProxyToken(token)).toBeNull()
  })

  it('returns null when the whole token is malformed', async () => {
    expect(await verifyProxyToken('not-a-jwt.not-base64.gibberish')).toBeNull()
  })
})

describe('extractProjectIdFromProxyToken', () => {
  it('extracts projectId without verifying the signature', async () => {
    const token = await generateProxyToken('hello-pid', 'wsid')
    expect(extractProjectIdFromProxyToken(token)).toBe('hello-pid')
  })

  it('returns null for a non-jwt string', () => {
    expect(extractProjectIdFromProxyToken('xyz')).toBeNull()
    expect(extractProjectIdFromProxyToken('one.two')).toBeNull()
  })

  it('returns null when payload JSON is corrupt', () => {
    expect(extractProjectIdFromProxyToken('a.NOTBASE64@@.c')).toBeNull()
  })

  it('returns null when projectId is missing from payload', () => {
    const fakePayload = Buffer.from(JSON.stringify({ workspaceId: 'w' })).toString('base64url')
    expect(extractProjectIdFromProxyToken(`a.${fakePayload}.c`)).toBeNull()
  })
})

describe('getProxySecret fallback behaviour', () => {
  it('falls back to a dev secret when no env var is set (non-production)', async () => {
    const original = process.env.AI_PROXY_SECRET
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'development'
    // Generation succeeds because dev fallback is allowed.
    const token = await generateProxyToken('p', 'w')
    // Restore secret so the verify below uses the same key — otherwise it
    // would return null due to fallback secret being constant.
    expect(typeof token).toBe('string')
    process.env.AI_PROXY_SECRET = original
  })

  it('throws in production when no secret is configured', async () => {
    const aps = process.env.AI_PROXY_SECRET
    const bas = process.env.BETTER_AUTH_SECRET
    const pts = process.env.PREVIEW_TOKEN_SECRET
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'production'
    try {
      await expect(generateProxyToken('p', 'w')).rejects.toThrow(/FATAL/)
    } finally {
      process.env.AI_PROXY_SECRET = aps
      process.env.BETTER_AUTH_SECRET = bas
      process.env.PREVIEW_TOKEN_SECRET = pts
    }
  })
})
