// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { decidePermission, isTrustedAppOrigin, type TrustedOriginOptions } from '../session-permissions'

const PACKAGED: TrustedOriginOptions = { isDev: false }
const DEV: TrustedOriginOptions = { isDev: true, devUrl: 'http://localhost:8081' }
const CLOUD: TrustedOriginOptions = { isDev: false, cloudUrl: 'https://studio.shogo.ai' }

describe('isTrustedAppOrigin', () => {
  test('trusts the packaged renderer', () => {
    expect(isTrustedAppOrigin('shogo://app', PACKAGED)).toBe(true)
    expect(isTrustedAppOrigin('shogo://app/index.html', PACKAGED)).toBe(true)
  })

  test('trusts localhost and 127.0.0.1 on any port', () => {
    for (const url of ['http://localhost', 'http://localhost:8081/x', 'https://localhost:39100/', 'http://127.0.0.1:3010/']) {
      expect(isTrustedAppOrigin(url, PACKAGED)).toBe(true)
    }
  })

  test('does not trust a hostname that merely starts with localhost', () => {
    // A prefix check would say yes here; the host has to match exactly.
    expect(isTrustedAppOrigin('http://localhost.evil.com', PACKAGED)).toBe(false)
    expect(isTrustedAppOrigin('http://127.0.0.1.evil.com', PACKAGED)).toBe(false)
    expect(isTrustedAppOrigin('https://notlocalhost', PACKAGED)).toBe(false)
  })

  test('does not trust other hosts or schemes', () => {
    expect(isTrustedAppOrigin('https://example.com', PACKAGED)).toBe(false)
    expect(isTrustedAppOrigin('file:///tmp/index.html', PACKAGED)).toBe(false)
    expect(isTrustedAppOrigin('data:text/html,hi', PACKAGED)).toBe(false)
  })

  test('handles empty and malformed input', () => {
    expect(isTrustedAppOrigin('', PACKAGED)).toBe(false)
    expect(isTrustedAppOrigin('not a url', PACKAGED)).toBe(false)
  })

  test('trusts the configured dev URL only in a dev build', () => {
    const devUrl = 'http://127.0.0.1:9000'
    expect(isTrustedAppOrigin('http://127.0.0.1:9000/app', { isDev: true, devUrl })).toBe(true)
    expect(isTrustedAppOrigin('http://127.0.0.1:9000.evil.com/', { isDev: true, devUrl })).toBe(false)
  })

  test('trusts the cloud URL by origin', () => {
    expect(isTrustedAppOrigin('https://studio.shogo.ai/workspaces/1', CLOUD)).toBe(true)
    expect(isTrustedAppOrigin('https://studio.shogo.ai.evil.com/', CLOUD)).toBe(false)
    expect(isTrustedAppOrigin('https://studio.shogo.ai/', PACKAGED)).toBe(false)
  })

  test('an unset dev or cloud URL trusts nothing extra', () => {
    expect(isTrustedAppOrigin('https://example.com', { isDev: true })).toBe(false)
    expect(isTrustedAppOrigin('https://example.com', { isDev: false, cloudUrl: '' })).toBe(false)
  })
})

describe('decidePermission', () => {
  test('media from a trusted origin keeps its TCC path', () => {
    expect(decidePermission('media', 'shogo://app', PACKAGED)).toBe('media')
    expect(decidePermission('media', 'http://localhost:3010', DEV)).toBe('media')
  })

  test('media from an untrusted origin is denied', () => {
    expect(decidePermission('media', 'https://example.com', PACKAGED)).toBe('deny')
    expect(decidePermission('media', '', PACKAGED)).toBe('deny')
  })

  test('fullscreen is allowed from our own origins', () => {
    expect(decidePermission('fullscreen', 'shogo://app', PACKAGED)).toBe('allow')
    expect(decidePermission('fullscreen', 'http://localhost:8081', DEV)).toBe('allow')
    expect(decidePermission('fullscreen', 'http://127.0.0.1:3010', PACKAGED)).toBe('allow')
    expect(decidePermission('fullscreen', 'https://studio.shogo.ai/x', CLOUD)).toBe('allow')
  })

  test('fullscreen from anywhere else is denied', () => {
    expect(decidePermission('fullscreen', 'https://example.com', PACKAGED)).toBe('deny')
    expect(decidePermission('fullscreen', 'shogo://app', { isDev: false })).toBe('allow')
    expect(decidePermission('fullscreen', 'http://localhost.evil.com', PACKAGED)).toBe('deny')
  })

  test('every other permission stays denied, trusted origin or not', () => {
    for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'openExternal', 'pointerLock']) {
      expect(decidePermission(permission, 'shogo://app', PACKAGED)).toBe('deny')
      expect(decidePermission(permission, 'http://localhost:3010', DEV)).toBe('deny')
    }
  })
})
