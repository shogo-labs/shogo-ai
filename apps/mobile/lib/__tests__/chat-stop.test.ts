// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat Stop Request Tests
 *
 * Validates that buildStopRequest produces the correct URL and auth
 * credentials for each platform/config combination.
 *
 * Run: bun test apps/mobile/lib/__tests__/chat-stop.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { buildStopRequest } from '../chat-stop'

const API_BASE = 'https://api.example.com'

describe('buildStopRequest', () => {
  test('returns null when neither localAgentUrl nor projectId is provided', () => {
    const result = buildStopRequest({
      apiBaseUrl: API_BASE,
      platform: 'web',
    })
    expect(result).toBeNull()
  })

  describe('local agent URL', () => {
    test('builds correct URL without auth credentials', () => {
      const result = buildStopRequest({
        localAgentUrl: 'http://localhost:8080',
        apiBaseUrl: API_BASE,
        platform: 'web',
      })

      expect(result).not.toBeNull()
      expect(result!.url).toBe('http://localhost:8080/agent/stop')
      expect(result!.init.method).toBe('POST')
      expect(result!.init.credentials).toBeUndefined()
      expect((result!.init.headers as Record<string, string>).Cookie).toBeUndefined()
    })

    test('prefers localAgentUrl over projectId', () => {
      const result = buildStopRequest({
        localAgentUrl: 'http://localhost:8080',
        projectId: 'proj-123',
        apiBaseUrl: API_BASE,
        platform: 'web',
      })

      expect(result!.url).toBe('http://localhost:8080/agent/stop')
    })
  })

  describe('remote API (web platform)', () => {
    test('builds correct URL with credentials: include', () => {
      const result = buildStopRequest({
        projectId: 'proj-123',
        apiBaseUrl: API_BASE,
        platform: 'web',
      })

      expect(result).not.toBeNull()
      expect(result!.url).toBe(`${API_BASE}/api/projects/proj-123/chat/stop`)
      expect(result!.init.credentials).toBe('include')
    })

    test('does not set Cookie header on web', () => {
      const result = buildStopRequest({
        projectId: 'proj-123',
        apiBaseUrl: API_BASE,
        platform: 'web',
        getCookie: () => 'session=abc',
      })

      expect((result!.init.headers as Record<string, string>).Cookie).toBeUndefined()
      expect(result!.init.credentials).toBe('include')
    })
  })

  describe('remote API (native platform)', () => {
    test('includes Cookie header from getCookie on iOS', () => {
      const result = buildStopRequest({
        projectId: 'proj-456',
        apiBaseUrl: API_BASE,
        platform: 'ios',
        getCookie: () => 'session=native-token',
      })

      expect(result).not.toBeNull()
      expect(result!.url).toBe(`${API_BASE}/api/projects/proj-456/chat/stop`)
      expect((result!.init.headers as Record<string, string>).Cookie).toBe('session=native-token')
      expect(result!.init.credentials).toBeUndefined()
    })

    test('includes Cookie header from getCookie on Android', () => {
      const result = buildStopRequest({
        projectId: 'proj-789',
        apiBaseUrl: API_BASE,
        platform: 'android',
        getCookie: () => 'session=droid-token',
      })

      expect(result!.url).toBe(`${API_BASE}/api/projects/proj-789/chat/stop`)
      expect((result!.init.headers as Record<string, string>).Cookie).toBe('session=droid-token')
    })

    test('omits Cookie header when getCookie returns null', () => {
      const result = buildStopRequest({
        projectId: 'proj-123',
        apiBaseUrl: API_BASE,
        platform: 'ios',
        getCookie: () => null,
      })

      expect(result).not.toBeNull()
      expect((result!.init.headers as Record<string, string>).Cookie).toBeUndefined()
    })

    test('omits Cookie header when getCookie is not provided', () => {
      const result = buildStopRequest({
        projectId: 'proj-123',
        apiBaseUrl: API_BASE,
        platform: 'ios',
      })

      expect(result).not.toBeNull()
      expect((result!.init.headers as Record<string, string>).Cookie).toBeUndefined()
    })
  })
})
