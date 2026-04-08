// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LAN Discovery & Authentication Tests (Phase 5)
 *
 * Run: bun test apps/api/src/__tests__/lan-discovery.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  registerLANInstance,
  removeLANInstance,
  getLANInstance,
  getAllLANInstances,
  getLANBaseUrl,
  clearDiscoveryCache,
  setLANAuthToken,
  getLANAuthToken,
  removeLANAuthToken,
  getLANAuthHeaders,
  type LANInstance,
} from '../../mobile/lib/remote-control/lan-discovery'

const sampleInstance: LANInstance = {
  instanceId: 'inst-1',
  hostname: 'my-laptop',
  ip: '192.168.1.100',
  port: 39100,
  protocolVersion: 2,
  apiVersion: '0.1.0',
  discoveredAt: Date.now(),
}

describe('Discovery Cache', () => {
  beforeEach(() => {
    clearDiscoveryCache()
  })

  test('registerLANInstance adds to cache', () => {
    registerLANInstance(sampleInstance)
    expect(getLANInstance('inst-1')).not.toBeNull()
    expect(getLANInstance('inst-1')!.ip).toBe('192.168.1.100')
  })

  test('removeLANInstance removes from cache', () => {
    registerLANInstance(sampleInstance)
    removeLANInstance('inst-1')
    expect(getLANInstance('inst-1')).toBeNull()
  })

  test('getLANInstance returns null for unknown', () => {
    expect(getLANInstance('unknown')).toBeNull()
  })

  test('getAllLANInstances returns all cached', () => {
    registerLANInstance(sampleInstance)
    registerLANInstance({ ...sampleInstance, instanceId: 'inst-2', ip: '192.168.1.101' })
    expect(getAllLANInstances()).toHaveLength(2)
  })

  test('clearDiscoveryCache empties the cache', () => {
    registerLANInstance(sampleInstance)
    clearDiscoveryCache()
    expect(getAllLANInstances()).toHaveLength(0)
  })
})

describe('getLANBaseUrl', () => {
  test('builds correct URL', () => {
    expect(getLANBaseUrl(sampleInstance)).toBe('http://192.168.1.100:39100')
  })
})

describe('LAN Authentication', () => {
  beforeEach(() => {
    removeLANAuthToken('inst-1')
    removeLANAuthToken('inst-2')
  })

  test('setLANAuthToken stores a token', () => {
    setLANAuthToken('inst-1', 'shogo_sk_test123')
    expect(getLANAuthToken('inst-1')).toBe('shogo_sk_test123')
  })

  test('getLANAuthToken returns null for unset instance', () => {
    expect(getLANAuthToken('inst-unknown')).toBeNull()
  })

  test('removeLANAuthToken removes the token', () => {
    setLANAuthToken('inst-1', 'token')
    removeLANAuthToken('inst-1')
    expect(getLANAuthToken('inst-1')).toBeNull()
  })

  test('getLANAuthHeaders returns x-api-key header when token set', () => {
    setLANAuthToken('inst-1', 'shogo_sk_mykey')
    const headers = getLANAuthHeaders('inst-1')
    expect(headers['x-api-key']).toBe('shogo_sk_mykey')
  })

  test('getLANAuthHeaders returns empty object when no token', () => {
    const headers = getLANAuthHeaders('inst-1')
    expect(Object.keys(headers)).toHaveLength(0)
  })

  test('different instances have independent tokens', () => {
    setLANAuthToken('inst-1', 'token-a')
    setLANAuthToken('inst-2', 'token-b')
    expect(getLANAuthToken('inst-1')).toBe('token-a')
    expect(getLANAuthToken('inst-2')).toBe('token-b')
  })
})
