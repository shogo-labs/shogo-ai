// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins the native OAuth `callbackURL` shape (SHO-414).
 *
 * `@better-auth/expo` only turns the callback into the app's deep link when it
 * is root-relative. If this ever starts returning an absolute `https://` URL on
 * native, the provider redirect lands on the website, the app never receives
 * the `?cookie=` hand-back, and sign-in silently leaves the user signed out.
 */

import { describe, expect, it } from 'bun:test'
import { resolveAuthCallbackUrl } from '../auth-callback-url'

describe('resolveAuthCallbackUrl', () => {
  it('stays root-relative on native so the expo plugin can build the deep link', () => {
    expect(resolveAuthCallbackUrl('/', null)).toBe('/')
    expect(resolveAuthCallbackUrl('/auth/cli-link?state=x', null)).toBe('/auth/cli-link?state=x')
  })

  it('never returns an absolute URL without an origin', () => {
    for (const next of ['/', '/sign-in', '/auth/cli-link?state=x&userCode=1']) {
      expect(resolveAuthCallbackUrl(next, null).startsWith('/')).toBe(true)
    }
  })

  it('prepends the origin on web so the round trip returns to the same origin', () => {
    expect(resolveAuthCallbackUrl('/', 'http://localhost:8081')).toBe('http://localhost:8081/')
    expect(resolveAuthCallbackUrl('/auth/cli-link?state=x', 'https://studio.shogo.ai')).toBe(
      'https://studio.shogo.ai/auth/cli-link?state=x',
    )
  })

  it('refuses protocol-relative and non-relative targets', () => {
    expect(resolveAuthCallbackUrl('//evil.example', null)).toBe('/')
    expect(resolveAuthCallbackUrl('https://evil.example', null)).toBe('/')
    expect(resolveAuthCallbackUrl('//evil.example', 'https://studio.shogo.ai')).toBe(
      'https://studio.shogo.ai/',
    )
  })
})
