// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  REQUEST_FORWARD_SKIP_HEADERS,
  RESPONSE_FORWARD_SKIP_HEADERS,
  shouldSkipForwardedHeader,
  shouldSkipResponseHeader,
} from '../lib/proxy-headers'

// RFC 7230 §6.1 hop-by-hop headers. Both skip-lists must contain all of these.
const HOP_BY_HOP = [
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
]

describe('REQUEST_FORWARD_SKIP_HEADERS', () => {
  test('contains every RFC 7230 §6.1 hop-by-hop header', () => {
    for (const name of HOP_BY_HOP) {
      expect(REQUEST_FORWARD_SKIP_HEADERS.has(name)).toBe(true)
    }
  })

  test('contains "cookie" (we do not forward browser cookies to API-key upstreams)', () => {
    expect(REQUEST_FORWARD_SKIP_HEADERS.has('cookie')).toBe(true)
  })

  test('does NOT include response-only headers', () => {
    expect(REQUEST_FORWARD_SKIP_HEADERS.has('content-encoding')).toBe(false)
    expect(REQUEST_FORWARD_SKIP_HEADERS.has('content-length')).toBe(false)
  })

  test('does NOT include headers we explicitly want to forward', () => {
    for (const name of [
      'authorization',
      'content-type',
      'accept',
      'user-agent',
      'x-forwarded-for',
      'x-request-id',
    ]) {
      expect(REQUEST_FORWARD_SKIP_HEADERS.has(name)).toBe(false)
    }
  })

  test('is a frozen / read-only contract (consumers should not mutate it)', () => {
    // TS marks it `ReadonlySet`; at runtime we just guard against accidental
    // expansion drifting the contract.
    const sizeBefore = REQUEST_FORWARD_SKIP_HEADERS.size
    expect(sizeBefore).toBe(HOP_BY_HOP.length + 1) // hop-by-hop + cookie
  })
})

describe('RESPONSE_FORWARD_SKIP_HEADERS', () => {
  test('is a strict superset of REQUEST_FORWARD_SKIP_HEADERS', () => {
    for (const name of REQUEST_FORWARD_SKIP_HEADERS) {
      expect(RESPONSE_FORWARD_SKIP_HEADERS.has(name)).toBe(true)
    }
    expect(RESPONSE_FORWARD_SKIP_HEADERS.size).toBeGreaterThan(REQUEST_FORWARD_SKIP_HEADERS.size)
  })

  test('adds content-encoding (Hono re-frames the body)', () => {
    expect(RESPONSE_FORWARD_SKIP_HEADERS.has('content-encoding')).toBe(true)
  })

  test('adds content-length (length no longer matches after re-framing)', () => {
    expect(RESPONSE_FORWARD_SKIP_HEADERS.has('content-length')).toBe(true)
  })

  test('contains every RFC 7230 §6.1 hop-by-hop header', () => {
    for (const name of HOP_BY_HOP) {
      expect(RESPONSE_FORWARD_SKIP_HEADERS.has(name)).toBe(true)
    }
  })

  test('size matches request-skip + 2 (content-encoding, content-length)', () => {
    expect(RESPONSE_FORWARD_SKIP_HEADERS.size).toBe(REQUEST_FORWARD_SKIP_HEADERS.size + 2)
  })
})

describe('shouldSkipForwardedHeader', () => {
  test('returns true for every entry in the skip-list', () => {
    for (const name of REQUEST_FORWARD_SKIP_HEADERS) {
      expect(shouldSkipForwardedHeader(name)).toBe(true)
    }
  })

  test('is case-insensitive', () => {
    expect(shouldSkipForwardedHeader('Cookie')).toBe(true)
    expect(shouldSkipForwardedHeader('COOKIE')).toBe(true)
    expect(shouldSkipForwardedHeader('cOoKiE')).toBe(true)
    expect(shouldSkipForwardedHeader('Host')).toBe(true)
    expect(shouldSkipForwardedHeader('Transfer-Encoding')).toBe(true)
    expect(shouldSkipForwardedHeader('TRANSFER-ENCODING')).toBe(true)
  })

  test('returns false for forwardable headers', () => {
    expect(shouldSkipForwardedHeader('authorization')).toBe(false)
    expect(shouldSkipForwardedHeader('Authorization')).toBe(false)
    expect(shouldSkipForwardedHeader('content-type')).toBe(false)
    expect(shouldSkipForwardedHeader('x-custom-header')).toBe(false)
    expect(shouldSkipForwardedHeader('user-agent')).toBe(false)
  })

  test('returns false for response-only headers (they belong to the response skip-list)', () => {
    expect(shouldSkipForwardedHeader('content-encoding')).toBe(false)
    expect(shouldSkipForwardedHeader('content-length')).toBe(false)
  })

  test('returns false for the empty string and unknown values', () => {
    expect(shouldSkipForwardedHeader('')).toBe(false)
    expect(shouldSkipForwardedHeader('not-a-real-header')).toBe(false)
  })
})

describe('shouldSkipResponseHeader', () => {
  test('returns true for every entry in the response skip-list', () => {
    for (const name of RESPONSE_FORWARD_SKIP_HEADERS) {
      expect(shouldSkipResponseHeader(name)).toBe(true)
    }
  })

  test('returns true for content-encoding and content-length regardless of case', () => {
    for (const name of ['content-encoding', 'Content-Encoding', 'CONTENT-ENCODING']) {
      expect(shouldSkipResponseHeader(name)).toBe(true)
    }
    for (const name of ['content-length', 'Content-Length', 'CONTENT-LENGTH']) {
      expect(shouldSkipResponseHeader(name)).toBe(true)
    }
  })

  test('also returns true for everything the request skip-list filters', () => {
    expect(shouldSkipResponseHeader('cookie')).toBe(true)
    expect(shouldSkipResponseHeader('Connection')).toBe(true)
    expect(shouldSkipResponseHeader('Transfer-Encoding')).toBe(true)
    expect(shouldSkipResponseHeader('host')).toBe(true)
  })

  test('returns false for headers we want to pass through to the client', () => {
    expect(shouldSkipResponseHeader('content-type')).toBe(false)
    expect(shouldSkipResponseHeader('cache-control')).toBe(false)
    expect(shouldSkipResponseHeader('etag')).toBe(false)
    expect(shouldSkipResponseHeader('x-request-id')).toBe(false)
    expect(shouldSkipResponseHeader('set-cookie')).toBe(false) // intentional: we forward Set-Cookie
  })

  test('returns false for the empty string and unknown values', () => {
    expect(shouldSkipResponseHeader('')).toBe(false)
    expect(shouldSkipResponseHeader('x-made-up')).toBe(false)
  })
})

describe('integration: filtering a Headers object', () => {
  test('shouldSkipForwardedHeader correctly partitions a realistic request', () => {
    const headers = new Headers({
      authorization: 'Bearer abc',
      'content-type': 'application/json',
      cookie: 'session=xyz',
      host: 'example.test',
      connection: 'keep-alive',
      'user-agent': 'jest',
    })

    const forwarded: Record<string, string> = {}
    headers.forEach((value, key) => {
      if (!shouldSkipForwardedHeader(key)) forwarded[key] = value
    })

    expect(forwarded).toEqual({
      authorization: 'Bearer abc',
      'content-type': 'application/json',
      'user-agent': 'jest',
    })
  })

  test('shouldSkipResponseHeader strips body-framing headers from upstream responses', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '1234',
      'cache-control': 'no-store',
      connection: 'close',
    })

    const passed: Record<string, string> = {}
    upstream.forEach((value, key) => {
      if (!shouldSkipResponseHeader(key)) passed[key] = value
    })

    expect(passed).toEqual({
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
  })
})
