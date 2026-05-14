// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `lib/url-validation.validateOutboundUrl`.
 *
 * The validator is the anti-SSRF gate for every outbound fetch the API
 * makes on behalf of a user (webhooks, OAuth callbacks, marketplace
 * image pulls, etc). It either returns `null` (safe) or a human-readable
 * reason string (blocked). The lint cases below pin every branch:
 *
 *   - URL parse failure
 *   - non-http(s) protocols
 *   - explicit hostname blocklist (localhost, GCP metadata)
 *   - IPv6 loopback (both `::1` and `[::1]`)
 *   - every regex in PRIVATE_IP_RANGES (loopback, 10/8, 172.16/12,
 *     192.168/16, link-local, current-network, CGNAT boundaries)
 *
 * Adding a new private range? Add a "blocked" case AND a neighboring
 * "allowed" case so future refactors can't silently widen the regex.
 */

import { describe, expect, test } from 'bun:test'
import { validateOutboundUrl } from '../lib/url-validation'

describe('validateOutboundUrl', () => {
  describe('input parsing', () => {
    test('returns "Invalid URL format" for unparsable input', () => {
      expect(validateOutboundUrl('not a url')).toBe('Invalid URL format')
      expect(validateOutboundUrl('')).toBe('Invalid URL format')
      expect(validateOutboundUrl('://missing-scheme')).toBe('Invalid URL format')
    })
  })

  describe('protocol allowlist', () => {
    test('allows http and https', () => {
      expect(validateOutboundUrl('http://example.com')).toBeNull()
      expect(validateOutboundUrl('https://example.com')).toBeNull()
    })

    test('blocks file:, ftp:, gopher:, javascript:', () => {
      expect(validateOutboundUrl('file:///etc/passwd')).toMatch(/Protocol "file:" is not allowed/)
      expect(validateOutboundUrl('ftp://example.com')).toMatch(/Protocol "ftp:" is not allowed/)
      expect(validateOutboundUrl('gopher://example.com')).toMatch(/Protocol "gopher:" is not allowed/)
      // javascript: URLs would be catastrophic if not blocked
      expect(validateOutboundUrl('javascript:alert(1)')).toMatch(/is not allowed/)
    })
  })

  describe('hostname blocklist', () => {
    test('blocks localhost in any casing', () => {
      expect(validateOutboundUrl('http://localhost/api')).toMatch(/Hostname "localhost"/)
      expect(validateOutboundUrl('http://LOCALHOST/api')).toMatch(/Hostname "localhost"/)
      expect(validateOutboundUrl('http://LocalHost:3000/foo')).toMatch(/Hostname "localhost"/)
    })

    test('blocks GCP metadata endpoints', () => {
      expect(validateOutboundUrl('http://metadata.google.internal/computeMetadata/v1/')).toMatch(
        /Hostname "metadata.google.internal"/,
      )
      expect(validateOutboundUrl('http://metadata.google/')).toMatch(/Hostname "metadata.google"/)
    })
  })

  describe('IPv6 loopback', () => {
    test('blocks ::1 in bracketed form (what the URL parser yields)', () => {
      // new URL('http://[::1]/').hostname === '[::1]'
      expect(validateOutboundUrl('http://[::1]/')).toBe('IPv6 loopback is not allowed')
    })
  })

  describe('private IPv4 ranges', () => {
    const blocked = [
      '127.0.0.1',
      '127.255.255.255',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.20.5.5',
      '172.31.255.254',
      '192.168.0.1',
      '192.168.255.1',
      '169.254.169.254', // AWS / Azure metadata
      '0.0.0.0',
      '100.64.0.1', // CGNAT lower bound
      '100.127.255.254', // CGNAT upper bound
    ]
    for (const ip of blocked) {
      test(`blocks ${ip}`, () => {
        const result = validateOutboundUrl(`http://${ip}/`)
        expect(result).toMatch(new RegExp(`Private IP address "${ip.replace(/\./g, '\\.')}"`))
      })
    }

    const allowed = [
      '8.8.8.8', // Google DNS
      '1.1.1.1', // Cloudflare DNS
      '11.0.0.1', // adjacent to 10/8
      '172.15.0.1', // one below 172.16/12
      '172.32.0.1', // one above 172.31
      '192.167.0.1', // one below 192.168
      '192.169.0.1', // one above 192.168
      '169.253.0.1', // one below link-local
      '169.255.0.1', // one above link-local
      '100.63.255.254', // one below CGNAT
      '100.128.0.1', // one above CGNAT
    ]
    for (const ip of allowed) {
      test(`allows ${ip}`, () => {
        expect(validateOutboundUrl(`http://${ip}/`)).toBeNull()
      })
    }
  })

  describe('public hostnames', () => {
    test('allows ordinary public DNS names', () => {
      expect(validateOutboundUrl('https://api.example.com/v1/things')).toBeNull()
      expect(validateOutboundUrl('https://example.com:8443/path?query=1')).toBeNull()
      expect(validateOutboundUrl('http://sub.deep.example.io/')).toBeNull()
    })

    test('does not accidentally block hostnames that contain "localhost" as a substring', () => {
      expect(validateOutboundUrl('https://not-localhost.example.com/')).toBeNull()
      expect(validateOutboundUrl('https://localhost.evil.com/')).toBeNull()
    })
  })
})
