// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `lib/crypto-util`.
 *
 * These helpers sit on the auth/webhook paths (runtime-token check,
 * Twilio & ElevenLabs HMAC verification, log redaction) and the cost
 * of getting them wrong is exfiltrating a bearer or leaking a token
 * prefix via timing. Test cases cover:
 *
 *   - `safeTokenEqual` / `safeBufferEqual`:
 *       equal / unequal-content / unequal-length / non-utf8 bytes
 *   - `redactSensitiveHeaders`:
 *       Headers vs plain object input, default sensitive set, the
 *       per-call `extraSensitive` extension, undefined input, and that
 *       non-sensitive values are passed through verbatim.
 *   - `fingerprintSecret`:
 *       short / empty / long input shape — never echoes more than the
 *       first 4 chars.
 */

import { describe, expect, test } from 'bun:test'
import {
  fingerprintSecret,
  redactSensitiveHeaders,
  safeBufferEqual,
  safeTokenEqual,
} from '../lib/crypto-util'

describe('safeTokenEqual', () => {
  test('returns true for byte-identical strings', () => {
    expect(safeTokenEqual('abc', 'abc')).toBe(true)
    expect(safeTokenEqual('', '')).toBe(true)
    const long = 'a'.repeat(256)
    expect(safeTokenEqual(long, long)).toBe(true)
  })

  test('returns false for different-content strings of the same length', () => {
    expect(safeTokenEqual('abc', 'abd')).toBe(false)
    expect(safeTokenEqual('aaaa', 'bbbb')).toBe(false)
  })

  test('returns false for different-length strings (length is not a secret)', () => {
    expect(safeTokenEqual('abc', 'abcd')).toBe(false)
    expect(safeTokenEqual('', 'a')).toBe(false)
  })

  test('handles UTF-8 multi-byte characters by comparing bytes, not code units', () => {
    // '🙂' is 4 UTF-8 bytes but 2 UTF-16 code units. The byte buffers
    // must match exactly.
    expect(safeTokenEqual('🙂', '🙂')).toBe(true)
    expect(safeTokenEqual('🙂', '🙃')).toBe(false)
  })
})

describe('safeBufferEqual', () => {
  test('returns true for byte-identical buffers', () => {
    expect(safeBufferEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true)
    expect(safeBufferEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(true)
  })

  test('returns false for different-content same-length buffers', () => {
    expect(safeBufferEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false)
  })

  test('returns false for different-length buffers without throwing', () => {
    // timingSafeEqual itself throws on unequal lengths — the helper
    // must swallow that and return false.
    expect(safeBufferEqual(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toBe(false)
  })
})

describe('redactSensitiveHeaders', () => {
  test('returns {} for undefined / nullish input', () => {
    expect(redactSensitiveHeaders(undefined)).toEqual({})
  })

  test('redacts every header in the default sensitive set (plain object input)', () => {
    const out = redactSensitiveHeaders({
      authorization: 'Bearer sk-live-abcdef1234567890',
      cookie: 'session=longopaquevalue',
      'x-runtime-token': 'rt-tokenvalueABCDEF',
      'x-tunnel-auth-user-id': 'user_12345',
      'x-tunnel-auth-email': 'someone@example.com',
      'x-tunnel-auth-name': 'Sample User',
      'x-api-key': 'apikey-9999999',
      'x-shogo-api-key': 'shogo-key-aaaaaaaa',
      'content-type': 'application/json',
      'user-agent': 'curl/8.0',
    })

    // Sensitive values are replaced with the "<len>c:<first4>…" fingerprint.
    expect(out.authorization).toMatch(/^\d+c:.{1,4}…$/)
    expect(out.authorization).not.toContain('sk-live-abcdef1234567890')
    expect(out.cookie).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-runtime-token']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-tunnel-auth-user-id']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-tunnel-auth-email']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-tunnel-auth-name']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-api-key']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-shogo-api-key']).toMatch(/^\d+c:.{1,4}…$/)

    // Non-sensitive headers pass through verbatim.
    expect(out['content-type']).toBe('application/json')
    expect(out['user-agent']).toBe('curl/8.0')
  })

  test('lowercases sensitive keys and matches case-insensitively (Headers input)', () => {
    const h = new Headers()
    h.set('Authorization', 'Bearer abcd-EFGH-ijkl')
    h.set('X-Runtime-Token', 'rt-XYZ123')
    h.set('Content-Type', 'application/json')

    const out = redactSensitiveHeaders(h)
    expect(out.authorization).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-runtime-token']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['content-type']).toBe('application/json')
  })

  test('extraSensitive extends the redaction set without mutating the default', () => {
    const out = redactSensitiveHeaders(
      {
        'x-billing-token': 'should-be-hidden-deadbeef',
        'x-trace-id': 'ok-to-log',
      },
      ['X-Billing-Token'],
    )
    expect(out['x-billing-token']).toMatch(/^\d+c:.{1,4}…$/)
    expect(out['x-billing-token']).not.toContain('deadbeef')
    expect(out['x-trace-id']).toBe('ok-to-log')

    // Second call without the extension must NOT carry over the
    // previous extraSensitive (i.e. no global mutation).
    const out2 = redactSensitiveHeaders({ 'x-billing-token': 'still-here' })
    expect(out2['x-billing-token']).toBe('still-here')
  })

  test('skips undefined header values rather than emitting "undefined"', () => {
    const out = redactSensitiveHeaders({
      authorization: undefined,
      'content-type': 'text/plain',
    })
    expect(out.authorization).toBeUndefined()
    expect(out['content-type']).toBe('text/plain')
  })
})

describe('fingerprintSecret', () => {
  test('returns "(empty)" for the empty string', () => {
    expect(fingerprintSecret('')).toBe('(empty)')
  })

  test('shape is "<len>c:<first4>…" and never echoes more than 4 chars', () => {
    const secret = 'sk-live-VERYSENSITIVESECRET-1234567890'
    const fp = fingerprintSecret(secret)
    expect(fp).toBe(`${secret.length}c:sk-l…`)
    expect(fp).not.toContain('VERYSENSITIVE')
  })

  test('handles secrets shorter than 4 chars (slice never overruns)', () => {
    expect(fingerprintSecret('a')).toBe('1c:a…')
    expect(fingerprintSecret('abc')).toBe('3c:abc…')
    expect(fingerprintSecret('abcd')).toBe('4c:abcd…')
  })
})
