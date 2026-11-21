// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SEC-33: `callbackURL=exp://attacker-host` was trusted in every environment,
 * and `@better-auth/expo` appends the session cookie to a trusted non-http
 * redirect. The Expo authorization proxy was also an open redirect.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { expo } from '@better-auth/expo'
import {
  expoAuthorizationProxyGuard,
  isAllowedAuthorizationURL,
  isLocalDevelopmentEnv,
  nativeTrustedOrigins,
} from '../lib/native-oauth-trust'

describe('nativeTrustedOrigins', () => {
  test('deployed environments trust only the app scheme', () => {
    for (const env of ['production', 'staging']) {
      expect(nativeTrustedOrigins(env)).toEqual(['shogo://'])
      expect(isLocalDevelopmentEnv(env)).toBe(false)
    }
  })

  test('a local developer API still trusts Expo Go', () => {
    for (const env of [undefined, '', 'development', 'test']) {
      expect(nativeTrustedOrigins(env)).toContain('exp://')
    }
  })

  test('auth.ts takes its native origins from the helper, not a literal exp://', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'auth.ts'), 'utf8')
    expect(src).not.toMatch(/'exp:\/\/'/)
    expect(src).toContain('...nativeTrustedOrigins()')
    expect(src).toContain('expoAuthorizationProxyGuard')
  })
})

describe('isAllowedAuthorizationURL', () => {
  test('allows the configured providers', () => {
    expect(isAllowedAuthorizationURL('https://accounts.google.com/o/oauth2/v2/auth?state=abc')).toBe(true)
    expect(isAllowedAuthorizationURL('https://appleid.apple.com/auth/authorize?state=abc')).toBe(true)
  })

  test('refuses anything else', () => {
    for (const url of [
      'https://evil.example/login?state=abc',
      'http://accounts.google.com/o/oauth2/v2/auth?state=abc',
      'https://accounts.google.com.evil.example/?state=abc',
      'https://user@accounts.google.com/?state=abc',
      'https://accounts.google.com:8443/?state=abc',
      'javascript:alert(1)',
      '//evil.example/?state=abc',
      '',
      undefined,
    ]) {
      expect(isAllowedAuthorizationURL(url)).toBe(false)
    }
  })
})

describe('expo-authorization-proxy through Better Auth', () => {
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'test-secret-test-secret-test-secret-0123',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    plugins: [expo(), expoAuthorizationProxyGuard],
  })
  const proxy = (target: string) =>
    auth.handler(
      new Request(
        `http://localhost:3000/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(target)}`,
      ),
    )

  test('refuses to redirect to an arbitrary site', async () => {
    const res = await proxy('https://evil.example/login?state=abc')
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  test('still forwards to Google', async () => {
    const res = await proxy('https://accounts.google.com/o/oauth2/v2/auth?state=abc')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toStartWith('https://accounts.google.com/')
  })
})
