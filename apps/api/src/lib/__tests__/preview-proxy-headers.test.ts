// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { filterUpstreamResponseHeaders, forwardClientHeaders } from '../preview-proxy-headers'

describe('forwardClientHeaders', () => {
  test('keeps the headers an app uses to authenticate the browser', () => {
    const incoming = new Headers()
    incoming.set('authorization', 'Bearer user-token')
    incoming.set('apikey', 'anon-key')
    incoming.set('cookie', 'sb=1')
    incoming.set('origin', 'https://8000--proj.preview.staging.shogo.ai')
    incoming.set('x-client-info', 'supabase-js')
    incoming.set('host', 'preview.internal')
    incoming.set('x-runtime-token', 'secret')
    const out = forwardClientHeaders(incoming)
    expect(out.get('authorization')).toBe('Bearer user-token')
    expect(out.get('apikey')).toBe('anon-key')
    expect(out.get('cookie')).toBe('sb=1')
    expect(out.get('origin')).toBe('https://8000--proj.preview.staging.shogo.ai')
    expect(out.get('x-client-info')).toBe('supabase-js')
    expect(out.get('host')).toBeNull()
    expect(out.get('x-runtime-token')).toBeNull()
  })
})

describe('filterUpstreamResponseHeaders', () => {
  test('passes set-cookie and strips the runtime token from a reflected response', () => {
    const upstream = new Headers()
    upstream.append('set-cookie', 'sb-access=abc; Path=/')
    upstream.append('set-cookie', 'sb-refresh=def; Path=/')
    upstream.set('x-runtime-token', 'secret')
    upstream.set('authorization', 'Bearer secret')
    upstream.set('content-type', 'application/json')
    upstream.set('x-frame-options', 'SAMEORIGIN')
    const out = filterUpstreamResponseHeaders(upstream, { passSetCookie: true })
    expect(out.get('content-type')).toBe('application/json')
    expect(out.get('x-runtime-token')).toBeNull()
    expect(out.get('authorization')).toBeNull()
    expect(out.get('x-frame-options')).toBeNull()
    expect(out.get('set-cookie')).toContain('sb-access=abc')
  })
})
