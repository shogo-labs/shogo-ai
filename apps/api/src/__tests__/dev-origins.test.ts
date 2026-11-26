// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/** SEC-3: staging reflected `Origin: null` with credentials. */

import { describe, expect, test } from 'bun:test'
import { isDevOriginAllowed } from '../lib/dev-origins'

describe('isDevOriginAllowed', () => {
  test('a deployed API never accepts Origin: null', () => {
    expect(isDevOriginAllowed('null', { NODE_ENV: 'staging' })).toBe(false)
    expect(isDevOriginAllowed('null', { NODE_ENV: 'production' })).toBe(false)
  })

  test('a local API (desktop / dev) still accepts it for the Electron scheme', () => {
    expect(isDevOriginAllowed('null', { NODE_ENV: 'production', SHOGO_LOCAL_MODE: 'true' })).toBe(true)
    expect(isDevOriginAllowed('null', {})).toBe(true)
    expect(isDevOriginAllowed('null', { NODE_ENV: 'development' })).toBe(true)
  })

  test('staging keeps localhost and LAN dev origins; production does not', () => {
    expect(isDevOriginAllowed('http://localhost:8081', { NODE_ENV: 'staging' })).toBe(true)
    expect(isDevOriginAllowed('http://192.168.1.20:8081', { NODE_ENV: 'staging' })).toBe(true)
    expect(isDevOriginAllowed('http://localhost:8081', { NODE_ENV: 'production' })).toBe(false)
  })

  test('an unrelated site is never a dev origin', () => {
    expect(isDevOriginAllowed('https://evil.example', {})).toBe(false)
  })
})
