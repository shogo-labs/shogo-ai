// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the shared constant-time compare + redaction helpers.
 *
 * These helpers are the single implementation that replaced three
 * hand-rolled copies (see `crypto-util.ts` docblock). Any change here
 * affects runtime-token auth, Twilio webhook verification, and
 * ElevenLabs webhook verification — keep the contract tight.
 */
import { describe, test, expect } from 'bun:test'
import {
  safeTokenEqual,
  safeBufferEqual,
  redactSensitiveHeaders,
  fingerprintSecret,
} from '../crypto-util'

describe('safeTokenEqual', () => {
  test('true for identical strings', () => {
    expect(safeTokenEqual('abc123', 'abc123')).toBe(true)
  })

  test('false for different same-length strings', () => {
    expect(safeTokenEqual('abc123', 'xyz789')).toBe(false)
  })

  test('false for different-length strings (no throw)', () => {
    expect(safeTokenEqual('abc', 'abcd')).toBe(false)
    expect(safeTokenEqual('abcd', 'abc')).toBe(false)
  })

  test('true for empty == empty', () => {
    expect(safeTokenEqual('', '')).toBe(true)
  })

  test('false for empty vs nonempty', () => {
    expect(safeTokenEqual('', 'x')).toBe(false)
    expect(safeTokenEqual('x', '')).toBe(false)
  })

  test('handles multi-byte UTF-8 (HMAC hex is ASCII, but contract should not misbehave)', () => {
    // "é" is 2 bytes in UTF-8; comparing byte buffers of different
    // byte-lengths must still return false rather than throwing.
    expect(safeTokenEqual('é', 'e')).toBe(false)
    expect(safeTokenEqual('é', 'é')).toBe(true)
  })
})

describe('safeBufferEqual', () => {
  test('true for identical buffers', () => {
    expect(safeBufferEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true)
  })

  test('false for different lengths', () => {
    expect(safeBufferEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false)
  })

  test('false for different contents', () => {
    expect(safeBufferEqual(Buffer.from('abc'), Buffer.from('xyz'))).toBe(false)
  })
})

describe('fingerprintSecret', () => {
  test('emits length + first 4 chars', () => {
    expect(fingerprintSecret('abcdef0123456789')).toBe('16c:abcd…')
  })

  test('does NOT expose the tail of the secret', () => {
    const secret = 'supersecrettokenvalue'
    const fp = fingerprintSecret(secret)
    expect(fp).not.toContain('tokenvalue')
    expect(fp).not.toContain('secret')
    // Only the first 4 chars should appear in the fingerprint.
    expect(fp).toContain('supe')
  })

  test('handles empty string gracefully', () => {
    expect(fingerprintSecret('')).toBe('(empty)')
  })
})

describe('redactSensitiveHeaders', () => {
  test('redacts the default credential headers', () => {
    const redacted = redactSensitiveHeaders({
      authorization: 'Bearer super-secret-token',
      'x-runtime-token': 'rt-abcdef123456',
      cookie: 'session=sekrit',
      'x-tunnel-auth-user-id': 'user_123',
      'x-tunnel-auth-email': 'a@b.com',
      'x-tunnel-auth-name': 'Alice',
      'x-api-key': 'sk_live_xxx',
      'x-shogo-api-key': 'shogo_sk_yyy',
      // Non-sensitive — should pass through.
      'content-type': 'application/json',
      'user-agent': 'bun/test',
    })
    // None of the sensitive headers should appear verbatim.
    for (const [key, v] of Object.entries(redacted)) {
      if (key === 'content-type' || key === 'user-agent') continue
      expect(v).not.toContain('super-secret-token')
      expect(v).not.toContain('rt-abcdef123456')
      expect(v).not.toContain('sekrit')
      expect(v).not.toContain('user_123')
      expect(v).not.toContain('a@b.com')
      expect(v).not.toContain('Alice')
      expect(v).not.toContain('sk_live_xxx')
      expect(v).not.toContain('shogo_sk_yyy')
      expect(v).toMatch(/^\d+c:.{0,4}…$|^\(empty\)$/)
    }
    expect(redacted['content-type']).toBe('application/json')
    expect(redacted['user-agent']).toBe('bun/test')
  })

  test('accepts a Fetch API Headers object', () => {
    const h = new Headers()
    h.set('authorization', 'Bearer abc')
    h.set('x-safe', 'ok')
    const redacted = redactSensitiveHeaders(h)
    expect(redacted['authorization']).toMatch(/^\d+c:/)
    expect(redacted['x-safe']).toBe('ok')
  })

  test('extraSensitive flags additional headers as secret', () => {
    const redacted = redactSensitiveHeaders(
      { 'x-custom-secret': 'shhhh', 'x-plain': 'ok' },
      ['x-custom-secret'],
    )
    expect(redacted['x-custom-secret']).not.toContain('shhhh')
    expect(redacted['x-plain']).toBe('ok')
  })

  test('is case-insensitive on header names', () => {
    const redacted = redactSensitiveHeaders({ Authorization: 'Bearer x', 'X-Runtime-Token': 'rt_abc' })
    // Normalized to lowercase keys.
    expect(redacted['authorization']).not.toContain('Bearer x')
    expect(redacted['x-runtime-token']).not.toContain('rt_abc')
  })

  test('ignores undefined input', () => {
    expect(redactSensitiveHeaders(undefined)).toEqual({})
  })
})
