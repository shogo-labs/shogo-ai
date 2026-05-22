// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  REQUEST_FORWARD_SKIP_HEADERS,
  RESPONSE_FORWARD_SKIP_HEADERS,
  shouldSkipForwardedHeader,
  shouldSkipResponseHeader,
} from '../proxy-headers'

describe('REQUEST_FORWARD_SKIP_HEADERS', () => {
  it('contains the RFC 7230 hop-by-hop headers', () => {
    for (const h of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']) {
      expect(REQUEST_FORWARD_SKIP_HEADERS.has(h)).toBe(true)
    }
  })
  it('contains cookie', () => {
    expect(REQUEST_FORWARD_SKIP_HEADERS.has('cookie')).toBe(true)
  })
  it('does NOT contain content-length or content-encoding', () => {
    expect(REQUEST_FORWARD_SKIP_HEADERS.has('content-length')).toBe(false)
    expect(REQUEST_FORWARD_SKIP_HEADERS.has('content-encoding')).toBe(false)
  })
})

describe('RESPONSE_FORWARD_SKIP_HEADERS', () => {
  it('is a superset of REQUEST_FORWARD_SKIP_HEADERS', () => {
    for (const h of REQUEST_FORWARD_SKIP_HEADERS) {
      expect(RESPONSE_FORWARD_SKIP_HEADERS.has(h)).toBe(true)
    }
  })
  it('adds content-encoding and content-length', () => {
    expect(RESPONSE_FORWARD_SKIP_HEADERS.has('content-encoding')).toBe(true)
    expect(RESPONSE_FORWARD_SKIP_HEADERS.has('content-length')).toBe(true)
  })
})

describe('shouldSkipForwardedHeader / shouldSkipResponseHeader', () => {
  it('shouldSkipForwardedHeader is case-insensitive', () => {
    expect(shouldSkipForwardedHeader('Host')).toBe(true)
    expect(shouldSkipForwardedHeader('HOST')).toBe(true)
    expect(shouldSkipForwardedHeader('Cookie')).toBe(true)
    expect(shouldSkipForwardedHeader('Authorization')).toBe(false)
  })

  it('shouldSkipResponseHeader is case-insensitive', () => {
    expect(shouldSkipResponseHeader('Content-Length')).toBe(true)
    expect(shouldSkipResponseHeader('CONTENT-ENCODING')).toBe(true)
    expect(shouldSkipResponseHeader('connection')).toBe(true)
    expect(shouldSkipResponseHeader('X-Custom')).toBe(false)
  })
})
