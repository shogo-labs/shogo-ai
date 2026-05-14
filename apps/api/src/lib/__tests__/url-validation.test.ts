// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the outbound URL validator (anti-SSRF guard).
 *
 * `validateOutboundUrl` returns `null` on safe URLs and a human-readable
 * reason string when it rejects. It's the single chokepoint protecting
 * webhook / fetch routes from hitting cloud metadata services, internal
 * RFC-1918 ranges, and non-HTTP protocols, so the contract must stay
 * tight. Each block below documents WHY a class of URL is rejected.
 */
import { describe, test, expect } from 'bun:test'
import { validateOutboundUrl } from '../url-validation'

describe('validateOutboundUrl — happy path', () => {
  test('accepts plain https URL', () => {
    expect(validateOutboundUrl('https://example.com/api/webhook')).toBeNull()
  })

  test('accepts plain http URL', () => {
    expect(validateOutboundUrl('http://example.com')).toBeNull()
  })

  test('accepts URL with port, query, fragment', () => {
    expect(
      validateOutboundUrl('https://api.example.com:8443/v1/x?y=1#frag'),
    ).toBeNull()
  })

  test('accepts a public IP that does NOT fall in any private range', () => {
    // 8.8.8.8 is Google DNS — globally routable, must be allowed so legit
    // outbound calls (DNS-over-HTTPS, etc.) still work.
    expect(validateOutboundUrl('https://8.8.8.8')).toBeNull()
  })

  test('accepts a 100.x address OUTSIDE the CGNAT block', () => {
    // CGNAT is 100.64.0.0/10 → 100.64.x – 100.127.x. 100.63 and 100.128
    // are public and must NOT be blocked. Without this, the regex's
    // upper bound (12[0-7]) is untested.
    expect(validateOutboundUrl('https://100.63.0.1')).toBeNull()
    expect(validateOutboundUrl('https://100.128.0.1')).toBeNull()
  })

  test('accepts 172.x addresses OUTSIDE the 172.16/12 private block', () => {
    // RFC1918 private B is 172.16.0.0 – 172.31.255.255. 172.15 and 172.32
    // are public.
    expect(validateOutboundUrl('https://172.15.0.1')).toBeNull()
    expect(validateOutboundUrl('https://172.32.0.1')).toBeNull()
  })
})

describe('validateOutboundUrl — protocol gate', () => {
  test('rejects file: protocol', () => {
    const err = validateOutboundUrl('file:///etc/passwd')
    expect(err).toContain('file:')
    expect(err).toContain('not allowed')
  })

  test('rejects ftp: protocol', () => {
    expect(validateOutboundUrl('ftp://example.com/x')).toContain('ftp:')
  })

  test('rejects javascript: protocol', () => {
    // No-op javascript: would let a malicious user trigger XSS-via-redirect
    // if any consumer later echoes the URL into HTML.
    expect(validateOutboundUrl('javascript:alert(1)')).toContain(
      'not allowed',
    )
  })

  test('rejects gopher: protocol (classic SSRF vector)', () => {
    expect(validateOutboundUrl('gopher://example.com')).toContain('gopher:')
  })
})

describe('validateOutboundUrl — hostname blocklist', () => {
  test('rejects localhost', () => {
    expect(validateOutboundUrl('http://localhost/admin')).toContain(
      'localhost',
    )
  })

  test('rejects localhost case-insensitively', () => {
    expect(validateOutboundUrl('http://LOCALHOST/admin')).toContain(
      'localhost',
    )
  })

  test('rejects metadata.google.internal (GCP metadata service)', () => {
    expect(
      validateOutboundUrl('http://metadata.google.internal/computeMetadata/v1/'),
    ).toContain('metadata.google.internal')
  })
})

describe('validateOutboundUrl — private IPv4 ranges', () => {
  test('rejects 127.0.0.1 (loopback)', () => {
    expect(validateOutboundUrl('http://127.0.0.1')).toContain('Private IP')
  })

  test('rejects 127.x.y.z (entire loopback /8)', () => {
    expect(validateOutboundUrl('http://127.255.255.254')).toContain(
      'Private IP',
    )
  })

  test('rejects 10.x (RFC1918 class A)', () => {
    expect(validateOutboundUrl('http://10.0.0.1')).toContain('Private IP')
  })

  test('rejects boundary 172.16.0.0 and 172.31.255.255 (RFC1918 class B)', () => {
    // Boundary check — the regex `172\.(1[6-9]|2\d|3[01])\.` is fiddly so
    // both ends matter.
    expect(validateOutboundUrl('http://172.16.0.0')).toContain('Private IP')
    expect(validateOutboundUrl('http://172.31.255.255')).toContain(
      'Private IP',
    )
  })

  test('rejects 192.168.x (RFC1918 class C)', () => {
    expect(validateOutboundUrl('http://192.168.1.1')).toContain('Private IP')
  })

  test('rejects 169.254.169.254 (AWS/Azure cloud metadata)', () => {
    // The single most dangerous SSRF target in cloud — must not regress.
    expect(
      validateOutboundUrl('http://169.254.169.254/latest/meta-data/'),
    ).toContain('Private IP')
  })

  test('rejects 0.0.0.0 (current network / "any address")', () => {
    expect(validateOutboundUrl('http://0.0.0.0')).toContain('Private IP')
  })

  test('rejects CGNAT 100.64.0.0/10 boundaries', () => {
    expect(validateOutboundUrl('http://100.64.0.0')).toContain('Private IP')
    expect(validateOutboundUrl('http://100.127.255.255')).toContain(
      'Private IP',
    )
  })
})

describe('validateOutboundUrl — IPv6 loopback', () => {
  test('rejects [::1] in URL form', () => {
    expect(validateOutboundUrl('http://[::1]/')).toContain('IPv6 loopback')
  })
})

describe('validateOutboundUrl — malformed input', () => {
  test('rejects garbage string', () => {
    expect(validateOutboundUrl('not a url')).toBe('Invalid URL format')
  })

  test('rejects empty string', () => {
    expect(validateOutboundUrl('')).toBe('Invalid URL format')
  })

  test('rejects URL missing scheme', () => {
    expect(validateOutboundUrl('example.com/foo')).toBe('Invalid URL format')
  })
})
